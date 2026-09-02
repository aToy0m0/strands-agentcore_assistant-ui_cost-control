import json
import os
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import boto3
from botocore.exceptions import BotoCoreError, ClientError


class PriceSourceInvalidError(Exception):
    pass


def lambda_handler(event, context, pricing_client=None, dynamodb_client=None, now=None):
    del event, context
    now = now or datetime.now(timezone.utc)
    pricing_client = pricing_client or boto3.client("pricing", region_name="us-east-1")
    dynamodb_client = dynamodb_client or boto3.client("dynamodb")
    table_name = required_environment("PRICING_TABLE_NAME")
    history_table_name = required_environment("PRICING_HISTORY_TABLE_NAME")
    validity_hours = int(os.environ.get("PRICE_VALIDITY_HOURS", "48"))
    if validity_hours < 25:
        raise ValueError("PRICE_VALIDITY_HOURS must be at least 25")

    items = scan_all(dynamodb_client, table_name)
    if not items:
        raise RuntimeError("model pricing catalog is empty")

    summary = {"matched": 0, "stopped": 0, "sourceErrors": 0, "skipped": 0}
    transient_errors = []
    for item in items:
        if string(item, "status") != "ACTIVE":
            summary["skipped"] += 1
            continue
        try:
            observed = observed_prices(pricing_client, item, now)
            expected_input = integer(item, "inputNanoUsdPerMillionTokens")
            expected_output = integer(item, "outputNanoUsdPerMillionTokens")
            if observed["input"] != expected_input or observed["output"] != expected_output:
                stop_model(dynamodb_client, table_name, history_table_name, item, "PRICE_MISMATCH", observed, now)
                summary["stopped"] += 1
                continue
            extend_verification(dynamodb_client, table_name, history_table_name, item, observed, now, validity_hours)
            summary["matched"] += 1
        except PriceSourceInvalidError as error:
            stop_model(dynamodb_client, table_name, history_table_name, item, "SOURCE_INVALID", None, now, str(error))
            summary["stopped"] += 1
        except (BotoCoreError, ClientError) as error:
            record_source_error(dynamodb_client, table_name, history_table_name, item, now, error)
            transient_errors.append(f"{string(item, 'modelId')}: {type(error).__name__}")
            summary["sourceErrors"] += 1

    print(json.dumps({"event": "pricing.verification.completed", **summary}, separators=(",", ":")))
    if transient_errors:
        raise RuntimeError("official price source could not be read: " + ", ".join(transient_errors))
    return summary


def observed_prices(pricing_client, item, now):
    service_code = string(item, "priceListServiceCode")
    attribute_name = string(item, "priceListProductAttributeName")
    attribute_value = string(item, "priceListProductAttributeValue")
    products = []
    next_token = None
    while True:
        request = {
            "ServiceCode": service_code,
            "FormatVersion": "aws_v1",
            "MaxResults": 100,
            "Filters": [
                {"Type": "TERM_MATCH", "Field": "regionCode", "Value": string(item, "sourceRegion")},
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

    input_result = one_current_price(products, string(item, "priceListInputUsageType"), now)
    output_result = one_current_price(products, string(item, "priceListOutputUsageType"), now)
    return {
        "input": input_result["nanoUsdPerMillionTokens"],
        "output": output_result["nanoUsdPerMillionTokens"],
        "publicationDate": max(input_result["publicationDate"], output_result["publicationDate"]),
        "inputSku": input_result["sku"],
        "outputSku": output_result["sku"],
    }


def one_current_price(products, usage_type, now):
    matches = []
    for product in products:
        attributes = product.get("product", {}).get("attributes", {})
        if attributes.get("usagetype") != usage_type:
            continue
        sku = product.get("product", {}).get("sku")
        publication_date = product.get("publicationDate")
        for term in product.get("terms", {}).get("OnDemand", {}).values():
            effective_at = parse_aws_date(term.get("effectiveDate"))
            if effective_at > now:
                continue
            for dimension in term.get("priceDimensions", {}).values():
                if dimension.get("beginRange") != "0" or dimension.get("endRange") != "Inf":
                    continue
                usd = dimension.get("pricePerUnit", {}).get("USD")
                unit = dimension.get("unit")
                if not sku or not publication_date or usd is None:
                    continue
                matches.append({
                    "nanoUsdPerMillionTokens": to_nano_usd_per_million(usd, unit),
                    "publicationDate": publication_date,
                    "effectiveAt": effective_at,
                    "sku": sku,
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


def extend_verification(client, table_name, history_table_name, item, observed, now, validity_hours):
    update = {
        "TableName": table_name,
        "Key": {"modelId": item["modelId"]},
        "UpdateExpression": "SET verifiedAt = :now, verifiedUntil = :until, lastVerificationStatus = :match, lastPriceListPublicationDate = :publication, lastInputSku = :inputSku, lastOutputSku = :outputSku REMOVE lastVerificationError, observedInputNanoUsdPerMillionTokens, observedOutputNanoUsdPerMillionTokens",
        "ConditionExpression": "#status = :active AND #version = :version AND inputNanoUsdPerMillionTokens = :input AND outputNanoUsdPerMillionTokens = :output",
        "ExpressionAttributeNames": {"#status": "status", "#version": "version"},
        "ExpressionAttributeValues": {
            ":now": {"S": iso(now)},
            ":until": {"S": iso(now + timedelta(hours=validity_hours))},
            ":match": {"S": "MATCH"},
            ":publication": {"S": observed["publicationDate"]},
            ":inputSku": {"S": observed["inputSku"]},
            ":outputSku": {"S": observed["outputSku"]},
            ":active": {"S": "ACTIVE"},
            ":version": item["version"],
            ":input": item["inputNanoUsdPerMillionTokens"],
            ":output": item["outputNanoUsdPerMillionTokens"],
        },
    }
    transact_with_history(client, update, history_table_name, history_item(item, "MATCH", observed, now))


def stop_model(client, table_name, history_table_name, item, status, observed, now, detail=None):
    values = {
        ":status": {"S": status},
        ":active": {"S": "ACTIVE"},
        ":version": item["version"],
        ":now": {"S": iso(now)},
        ":error": {"S": (detail or status)[:1000]},
    }
    expression = "SET #status = :status, lastVerificationStatus = :status, lastVerificationAt = :now, lastVerificationError = :error"
    if observed:
        expression += ", observedInputNanoUsdPerMillionTokens = :observedInput, observedOutputNanoUsdPerMillionTokens = :observedOutput, lastPriceListPublicationDate = :publication"
        values.update({
            ":observedInput": {"N": str(observed["input"])},
            ":observedOutput": {"N": str(observed["output"])},
            ":publication": {"S": observed["publicationDate"]},
        })
    update = {
        "TableName": table_name,
        "Key": {"modelId": item["modelId"]},
        "UpdateExpression": expression,
        "ConditionExpression": "#status = :active AND #version = :version",
        "ExpressionAttributeNames": {"#status": "status", "#version": "version"},
        "ExpressionAttributeValues": values,
    }
    transact_with_history(client, update, history_table_name, history_item(item, status, observed, now, detail))


def record_source_error(client, table_name, history_table_name, item, now, error):
    detail = f"{type(error).__name__}: {error}"[:1000]
    update = {
        "TableName": table_name,
        "Key": {"modelId": item["modelId"]},
        "UpdateExpression": "SET lastVerificationStatus = :sourceError, lastVerificationAt = :now, lastVerificationError = :error",
        "ConditionExpression": "#status = :active AND #version = :version",
        "ExpressionAttributeNames": {"#status": "status", "#version": "version"},
        "ExpressionAttributeValues": {
            ":sourceError": {"S": "SOURCE_ERROR"},
            ":now": {"S": iso(now)},
            ":error": {"S": detail},
            ":active": {"S": "ACTIVE"},
            ":version": item["version"],
        },
    }
    transact_with_history(client, update, history_table_name, history_item(item, "SOURCE_ERROR", None, now, detail))


def transact_with_history(client, update, history_table_name, audit_item):
    client.transact_write_items(TransactItems=[
        {"Update": update},
        {"Put": {
            "TableName": history_table_name,
            "Item": audit_item,
            "ConditionExpression": "attribute_not_exists(modelId) AND attribute_not_exists(verificationId)",
        }},
    ])


def history_item(item, status, observed, now, detail=None):
    verification_id = f"{iso(now)}#{string(item, 'version')}"
    result = {
        "modelId": item["modelId"],
        "verificationId": {"S": verification_id},
        "status": {"S": status},
        "version": item["version"],
        "verifiedAt": {"S": iso(now)},
        "expiresAt": {"N": str(int((now + timedelta(days=180)).timestamp()))},
        "inputNanoUsdPerMillionTokens": item["inputNanoUsdPerMillionTokens"],
        "outputNanoUsdPerMillionTokens": item["outputNanoUsdPerMillionTokens"],
        "priceListServiceCode": item["priceListServiceCode"],
        "priceListProductAttributeName": item["priceListProductAttributeName"],
        "priceListProductAttributeValue": item["priceListProductAttributeValue"],
        "priceListInputUsageType": item["priceListInputUsageType"],
        "priceListOutputUsageType": item["priceListOutputUsageType"],
    }
    if observed:
        result.update({
            "observedInputNanoUsdPerMillionTokens": {"N": str(observed["input"])},
            "observedOutputNanoUsdPerMillionTokens": {"N": str(observed["output"])},
            "priceListPublicationDate": {"S": observed["publicationDate"]},
            "inputSku": {"S": observed["inputSku"]},
            "outputSku": {"S": observed["outputSku"]},
        })
    if detail:
        result["detail"] = {"S": detail[:1000]}
    return result


def scan_all(client, table_name):
    items = []
    start_key = None
    while True:
        request = {"TableName": table_name, "ConsistentRead": True}
        if start_key:
            request["ExclusiveStartKey"] = start_key
        response = client.scan(**request)
        items.extend(response.get("Items", []))
        start_key = response.get("LastEvaluatedKey")
        if not start_key:
            return items


def required_environment(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def string(item, name):
    value = item.get(name, {}).get("S", "").strip()
    if not value:
        raise PriceSourceInvalidError(f"pricing catalog field is missing: {name}")
    return value


def integer(item, name):
    value = item.get(name, {}).get("N", "")
    if not value.isdigit():
        raise PriceSourceInvalidError(f"pricing catalog integer is invalid: {name}")
    return int(value)


def parse_aws_date(value):
    if not value:
        raise PriceSourceInvalidError("Price List effectiveDate is missing")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
