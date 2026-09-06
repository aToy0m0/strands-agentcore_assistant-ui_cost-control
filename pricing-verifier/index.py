import json
import os
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from botocore.exceptions import BotoCoreError, ClientError


class PriceSourceInvalidError(Exception):
    pass


def lambda_handler(event, context, pricing_client=None, s3_client=None, now=None):
    del event, context
    now = now or datetime.now(timezone.utc)
    pricing_client = pricing_client or boto3.client("pricing", region_name="us-east-1")
    s3_client = s3_client or boto3.client("s3")
    catalog = load_catalog(
        s3_client,
        required_environment("PRICING_CATALOG_BUCKET_NAME"),
        required_environment("PRICING_CATALOG_OBJECT_KEY"),
    )
    models = catalog.get("models")
    if not isinstance(models, dict) or not models:
        raise RuntimeError("model pricing catalog is empty or invalid")

    summary = {"matched": 0, "mismatched": 0, "sourceInvalid": 0, "sourceErrors": 0, "reviewOverdue": 0, "skipped": 0}
    for model_id, item in models.items():
        if not isinstance(item, dict):
            emit_warning(model_id, "SOURCE_INVALID", now, detail="model entry is not an object")
            summary["sourceInvalid"] += 1
            continue
        try:
            review_due_at = parse_date(required_string(item, "reviewDueAt"))
            if review_due_at < now:
                emit_warning(model_id, "REVIEW_OVERDUE", now, detail=f"reviewDueAt={iso(review_due_at)}")
                summary["reviewOverdue"] += 1
            if item.get("sourceProvider", "aws") != "aws":
                summary["skipped"] += 1
                continue
            observed = observed_prices(pricing_client, item, now)
            expected_input = positive_integer(item, "inputNanoUsdPerMillionTokens")
            expected_output = positive_integer(item, "outputNanoUsdPerMillionTokens")
            if observed["input"] != expected_input or observed["output"] != expected_output:
                emit_warning(model_id, "PRICE_MISMATCH", now, observed=observed, expected={"input": expected_input, "output": expected_output})
                summary["mismatched"] += 1
            else:
                summary["matched"] += 1
        except PriceSourceInvalidError as error:
            emit_warning(model_id, "SOURCE_INVALID", now, detail=str(error))
            summary["sourceInvalid"] += 1
        except (BotoCoreError, ClientError) as error:
            emit_warning(model_id, "SOURCE_ERROR", now, detail=f"{type(error).__name__}: {error}")
            summary["sourceErrors"] += 1

    print(json.dumps({"event": "pricing.verification.completed", **summary}, separators=(",", ":")))
    return summary


def load_catalog(s3_client, bucket_name, object_key):
    response = s3_client.get_object(Bucket=bucket_name, Key=object_key)
    body = response.get("Body")
    if body is None:
        raise RuntimeError("model pricing catalog body is missing")
    value = json.loads(body.read().decode("utf-8"))
    if value.get("schemaVersion") != 1 or value.get("currency") != "USD" or not value.get("catalogVersion"):
        raise RuntimeError("model pricing catalog header is invalid")
    return value


def observed_prices(pricing_client, item, now):
    price_list = item.get("priceList")
    if not isinstance(price_list, dict):
        raise PriceSourceInvalidError("priceList is missing")
    service_code = required_string(price_list, "serviceCode")
    attribute_name = required_string(price_list, "productAttributeName")
    attribute_value = required_string(price_list, "productAttributeValue")
    products = []
    next_token = None
    while True:
        request = {
            "ServiceCode": service_code,
            "FormatVersion": "aws_v1",
            "MaxResults": 100,
            "Filters": [
                {"Type": "TERM_MATCH", "Field": "regionCode", "Value": required_string(item, "sourceRegion")},
                {"Type": "TERM_MATCH", "Field": attribute_name, "Value": attribute_value},
            ],
        }
        if next_token:
            request["NextToken"] = next_token
        response = pricing_client.get_products(**request)
        products.extend(json.loads(value) for value in response.get("PriceList", []))
        next_token = response.get("NextToken")
        if not next_token:
            break

    input_result = one_current_price(products, required_string(price_list, "inputUsageType"), now)
    output_result = one_current_price(products, required_string(price_list, "outputUsageType"), now)
    return {
        "input": input_result["nanoUsdPerMillionTokens"],
        "output": output_result["nanoUsdPerMillionTokens"],
        "publicationDate": max(input_result["publicationDate"], output_result["publicationDate"]),
    }


def one_current_price(products, usage_type, now):
    matches = []
    for product in products:
        attributes = product.get("product", {}).get("attributes", {})
        if attributes.get("usagetype") != usage_type:
            continue
        publication_date = product.get("publicationDate")
        for term in product.get("terms", {}).get("OnDemand", {}).values():
            if parse_date(term.get("effectiveDate")) > now:
                continue
            for dimension in term.get("priceDimensions", {}).values():
                if dimension.get("beginRange") != "0" or dimension.get("endRange") != "Inf":
                    continue
                usd = dimension.get("pricePerUnit", {}).get("USD")
                if publication_date and usd is not None:
                    matches.append({
                        "nanoUsdPerMillionTokens": to_nano_usd_per_million(usd, dimension.get("unit")),
                        "publicationDate": publication_date,
                    })
    if len(matches) != 1:
        raise PriceSourceInvalidError(f"expected exactly one current Price List dimension for {usage_type}, found {len(matches)}")
    return matches[0]


def to_nano_usd_per_million(usd, unit):
    token_multiplier = {"1M tokens": Decimal(1), "1K tokens": Decimal(1000)}.get(unit)
    if token_multiplier is None:
        raise PriceSourceInvalidError(f"unsupported Price List unit: {unit}")
    value = Decimal(str(usd)) * token_multiplier * Decimal(1_000_000_000)
    if value != value.to_integral_value() or value <= 0:
        raise PriceSourceInvalidError("Price List value cannot be represented as positive integer nano USD")
    return int(value)


def emit_warning(model_id, status, now, observed=None, expected=None, detail=None):
    warning = {"event": "pricing.verification.warning", "level": "WARN", "modelId": model_id, "status": status, "observedAt": iso(now)}
    if expected:
        warning["configuredInputNanoUsdPerMillionTokens"] = expected["input"]
        warning["configuredOutputNanoUsdPerMillionTokens"] = expected["output"]
    if observed:
        warning["observedInputNanoUsdPerMillionTokens"] = observed["input"]
        warning["observedOutputNanoUsdPerMillionTokens"] = observed["output"]
        warning["priceListPublicationDate"] = observed["publicationDate"]
    if detail:
        warning["detail"] = detail[:1000]
    print(json.dumps(warning, separators=(",", ":")))


def required_environment(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def required_string(item, name):
    value = item.get(name)
    if not isinstance(value, str) or not value.strip():
        raise PriceSourceInvalidError(f"pricing catalog field is missing: {name}")
    return value


def positive_integer(item, name):
    value = required_string(item, name)
    if not value.isdigit() or int(value) <= 0:
        raise PriceSourceInvalidError(f"pricing catalog integer is invalid: {name}")
    return int(value)


def parse_date(value):
    if not value:
        raise PriceSourceInvalidError("price date is missing")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
