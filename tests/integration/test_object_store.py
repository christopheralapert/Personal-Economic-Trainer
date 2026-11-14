import os
from uuid import uuid4

import boto3
import httpx
import pytest
from botocore.config import Config


def test_private_s3_roundtrip_and_anonymous_denial():
    endpoint = os.environ.get("MONEYLENS_TEST_S3_ENDPOINT")
    if not endpoint:
        pytest.skip("Set MONEYLENS_TEST_S3_ENDPOINT for real local/CI storage verification")
    client = boto3.client("s3", endpoint_url=endpoint,
        aws_access_key_id=os.environ["MONEYLENS_TEST_S3_ACCESS_KEY"],
        aws_secret_access_key=os.environ["MONEYLENS_TEST_S3_SECRET_KEY"], region_name="us-east-1",
        config=Config(signature_version="s3v4", s3={"addressing_style":"path"}, connect_timeout=5, read_timeout=10))
    bucket = "moneylens-test-" + uuid4().hex
    key = "synthetic/probe.txt"
    client.create_bucket(Bucket=bucket)
    try:
        client.put_object(Bucket=bucket, Key=key, Body=b"publicly invented test bytes")
        response = client.get_object(Bucket=bucket, Key=key)
        with response["Body"] as body:
            assert body.read() == b"publicly invented test bytes"
        assert httpx.get(f"{endpoint}/{bucket}/{key}", timeout=10).status_code == 403
    finally:
        client.delete_object(Bucket=bucket, Key=key)
        client.delete_bucket(Bucket=bucket)
