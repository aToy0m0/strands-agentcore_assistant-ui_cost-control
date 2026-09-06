import io
import json
import os
import unittest
from datetime import datetime, timezone
from unittest.mock import Mock, patch

import index


NOW = datetime(2026, 9, 2, 3, 17, tzinfo=timezone.utc)


def model(input_price="1100000000", output_price="5500000000", source_provider="aws"):
    value = {
        "sourceProvider": source_provider,
        "sourceRegion": "us-east-1",
        "verifiedAt": "2026-09-01T00:00:00Z",
        "reviewDueAt": "2026-09-30T00:00:00Z",
        "inputNanoUsdPerMillionTokens": input_price,
        "outputNanoUsdPerMillionTokens": output_price,
    }
    if source_provider == "aws":
        value["priceList"] = {
            "serviceCode": "AmazonBedrockFoundationModels",
            "productAttributeName": "servicename",
            "productAttributeValue": "Example model",
            "inputUsageType": "INPUT",
            "outputUsageType": "OUTPUT",
        }
    return value


def catalog(item=None):
    return {"schemaVersion": 1, "catalogVersion": "v1", "currency": "USD", "models": {"model-1": item or model()}}


def product(usage_type, usd):
    return json.dumps({
        "product": {"attributes": {"usagetype": usage_type}},
        "publicationDate": "2026-09-01T18:36:49Z",
        "terms": {"OnDemand": {"term": {
            "effectiveDate": "2026-08-01T00:00:00Z",
            "priceDimensions": {"dimension": {
                "beginRange": "0", "endRange": "Inf", "unit": "1M tokens", "pricePerUnit": {"USD": usd},
            }},
        }}},
    })


class PricingVerifierTest(unittest.TestCase):
    def setUp(self):
        os.environ["PRICING_CATALOG_BUCKET_NAME"] = "prices"
        os.environ["PRICING_CATALOG_OBJECT_KEY"] = "catalog/model-pricing.json"
        self.s3 = Mock()
        self.pricing = Mock()
        self.pricing.get_products.return_value = {"PriceList": [product("INPUT", "1.1"), product("OUTPUT", "5.5")]}

    def run_catalog(self, value):
        self.s3.get_object.return_value = {"Body": io.BytesIO(json.dumps(value).encode("utf-8"))}
        return index.lambda_handler({}, None, self.pricing, self.s3, NOW)

    def test_matching_prices_do_not_mutate_catalog(self):
        result = self.run_catalog(catalog())
        self.assertEqual(result["matched"], 1)
        self.s3.put_object.assert_not_called()

    def test_changed_price_only_emits_warning(self):
        self.pricing.get_products.return_value = {"PriceList": [product("INPUT", "1.2"), product("OUTPUT", "5.5")]}
        with patch("builtins.print") as output:
            result = self.run_catalog(catalog())
        self.assertEqual(result["mismatched"], 1)
        self.assertTrue(any("PRICE_MISMATCH" in str(call) for call in output.call_args_list))
        self.s3.put_object.assert_not_called()

    def test_external_provider_uses_review_deadline_without_scraping(self):
        external = model(source_provider="google")
        external["reviewDueAt"] = "2026-09-01T00:00:00Z"
        with patch("builtins.print") as output:
            result = self.run_catalog(catalog(external))
        self.assertEqual(result["reviewOverdue"], 1)
        self.assertEqual(result["skipped"], 1)
        self.pricing.get_products.assert_not_called()
        self.assertTrue(any("REVIEW_OVERDUE" in str(call) for call in output.call_args_list))

    def test_converts_1k_token_price_to_per_million_nano_usd(self):
        self.assertEqual(index.to_nano_usd_per_million("0.0003300000", "1K tokens"), 330_000_000)


if __name__ == "__main__":
    unittest.main()
