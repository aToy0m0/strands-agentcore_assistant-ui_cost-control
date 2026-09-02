import json
import os
import unittest
from datetime import datetime, timezone
from unittest.mock import Mock

import index


NOW = datetime(2026, 9, 2, 3, 17, tzinfo=timezone.utc)


def item(input_price="1100000000", output_price="5500000000"):
    strings = {
        "modelId": "model-1",
        "status": "ACTIVE",
        "version": "v1",
        "sourceRegion": "us-east-1",
        "priceListServiceCode": "AmazonBedrockFoundationModels",
        "priceListProductAttributeName": "servicename",
        "priceListProductAttributeValue": "Claude Haiku 4.5 (Amazon Bedrock Edition)",
        "priceListInputUsageType": "INPUT",
        "priceListOutputUsageType": "OUTPUT",
    }
    result = {key: {"S": value} for key, value in strings.items()}
    result["inputNanoUsdPerMillionTokens"] = {"N": input_price}
    result["outputNanoUsdPerMillionTokens"] = {"N": output_price}
    return result


def product(usage_type, usd, sku):
    return json.dumps({
        "product": {"sku": sku, "attributes": {"usagetype": usage_type}},
        "publicationDate": "2026-09-01T18:36:49Z",
        "terms": {"OnDemand": {"term": {
            "effectiveDate": "2026-08-01T00:00:00Z",
            "priceDimensions": {"dimension": {
                "beginRange": "0", "endRange": "Inf", "unit": "1M tokens",
                "pricePerUnit": {"USD": usd},
            }},
        }}},
    })


class PricingVerifierTest(unittest.TestCase):
    def setUp(self):
        os.environ["PRICING_TABLE_NAME"] = "prices"
        os.environ["PRICING_HISTORY_TABLE_NAME"] = "history"
        os.environ["PRICE_VALIDITY_HOURS"] = "48"
        self.ddb = Mock()
        self.ddb.scan.return_value = {"Items": [item()]}
        self.pricing = Mock()
        self.pricing.get_products.return_value = {"PriceList": [product("INPUT", "1.1", "sku-in"), product("OUTPUT", "5.5", "sku-out")]}

    def test_matching_prices_extend_deadline(self):
        result = index.lambda_handler({}, None, self.pricing, self.ddb, NOW)
        self.assertEqual(result, {"matched": 1, "stopped": 0, "sourceErrors": 0, "skipped": 0})
        transaction = self.ddb.transact_write_items.call_args.kwargs["TransactItems"]
        request = transaction[0]["Update"]
        self.assertEqual(request["ExpressionAttributeValues"][":until"]["S"], "2026-09-04T03:17:00.000Z")
        self.assertIn("verifiedUntil", request["UpdateExpression"])
        history = transaction[1]["Put"]
        self.assertEqual(history["TableName"], "history")
        self.assertEqual(history["Item"]["verificationId"]["S"], "2026-09-02T03:17:00.000Z#v1")
        self.assertEqual(history["Item"]["status"]["S"], "MATCH")
        self.assertEqual(history["Item"]["expiresAt"]["N"], "1803871020")

    def test_changed_price_stops_model_without_overwriting_master_price(self):
        self.pricing.get_products.return_value = {"PriceList": [product("INPUT", "1.2", "sku-in"), product("OUTPUT", "5.5", "sku-out")]}
        result = index.lambda_handler({}, None, self.pricing, self.ddb, NOW)
        self.assertEqual(result["stopped"], 1)
        transaction = self.ddb.transact_write_items.call_args.kwargs["TransactItems"]
        request = transaction[0]["Update"]
        self.assertEqual(request["ExpressionAttributeValues"][":status"]["S"], "PRICE_MISMATCH")
        self.assertNotIn("inputNanoUsdPerMillionTokens =", request["UpdateExpression"])
        self.assertEqual(transaction[1]["Put"]["Item"]["status"]["S"], "PRICE_MISMATCH")

    def test_ambiguous_source_stops_model(self):
        self.pricing.get_products.return_value = {"PriceList": [product("INPUT", "1.1", "one"), product("INPUT", "1.1", "two"), product("OUTPUT", "5.5", "out")]}
        result = index.lambda_handler({}, None, self.pricing, self.ddb, NOW)
        self.assertEqual(result["stopped"], 1)
        transaction = self.ddb.transact_write_items.call_args.kwargs["TransactItems"]
        self.assertEqual(transaction[0]["Update"]["ExpressionAttributeValues"][":status"]["S"], "SOURCE_INVALID")
        self.assertEqual(transaction[1]["Put"]["Item"]["status"]["S"], "SOURCE_INVALID")

    def test_transient_api_failure_does_not_extend_deadline(self):
        from botocore.exceptions import EndpointConnectionError
        self.pricing.get_products.side_effect = EndpointConnectionError(endpoint_url="https://pricing.us-east-1.amazonaws.com")
        with self.assertRaisesRegex(RuntimeError, "official price source"):
            index.lambda_handler({}, None, self.pricing, self.ddb, NOW)
        transaction = self.ddb.transact_write_items.call_args.kwargs["TransactItems"]
        request = transaction[0]["Update"]
        self.assertNotIn("verifiedUntil", request["UpdateExpression"])
        self.assertEqual(request["ExpressionAttributeValues"][":sourceError"]["S"], "SOURCE_ERROR")
        self.assertEqual(transaction[1]["Put"]["Item"]["status"]["S"], "SOURCE_ERROR")

    def test_converts_1k_token_price_to_per_million_nano_usd(self):
        self.assertEqual(index.to_nano_usd_per_million("0.0003300000", "1K tokens"), 330_000_000)


if __name__ == "__main__":
    unittest.main()
