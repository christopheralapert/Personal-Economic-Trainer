"""Private write-once S3 objects. No client-chosen bucket, key or read URL."""
import base64
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
from io import BytesIO
import time
from uuid import UUID

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError,ClientError

from .import_contracts import UploadLinkV1


class ImportObjectError(Exception):
    def __init__(self,code,*,permanent=False):
        self.code,self.permanent=code,permanent
        super().__init__(code)


@dataclass(frozen=True)
class VerifiedImportFile:
    role: str
    size_bytes: int
    sha256: str
    etag: str


def object_key(scope,import_id,role):
    if not isinstance(import_id,UUID) or role not in ("accounts","transactions","balances"):
        raise ValueError("Use a registered import file reference")
    return f"raw/{scope.tenant_id}/{scope.user_id}/{import_id}/{role}.csv"


class ImportObjects:
    def __init__(self,settings):
        self.bucket=settings.object_store_bucket
        self.client=boto3.client("s3",endpoint_url=settings.object_store_endpoint,
            aws_access_key_id=settings.object_store_access_key.get_secret_value(),
            aws_secret_access_key=settings.object_store_secret_key.get_secret_value(),
            region_name=settings.object_store_region,
            config=Config(signature_version="s3v4",s3={"addressing_style":"path"},
                connect_timeout=5,read_timeout=10,retries={"max_attempts":0}))

    def close(self):
        self.client.close()

    def upload_link(self,scope,import_id,file,seconds):
        checksum=base64.b64encode(bytes.fromhex(file.sha256)).decode("ascii")
        headers={"Content-Type":"text/csv","If-None-Match":"*","x-amz-checksum-sha256":checksum}
        url=self.client.generate_presigned_url("put_object",Params={"Bucket":self.bucket,
            "Key":object_key(scope,import_id,file.role),"ContentType":"text/csv","ContentLength":file.size_bytes,
            "IfNoneMatch":"*","ChecksumSHA256":checksum},ExpiresIn=seconds,HttpMethod="PUT")
        return UploadLinkV1(role=file.role,url=url,headers=headers,size_bytes=file.size_bytes)

    def verify(self,scope,import_id,file,*,deadline):
        if time.monotonic()>=deadline: raise ImportObjectError("import_source_timeout")
        try:
            response=self.client.get_object(Bucket=self.bucket,Key=object_key(scope,import_id,file.role))
            body=response["Body"]
            try:
                if response["ContentLength"]!=file.size_bytes:
                    raise ImportObjectError("import_size_mismatch",permanent=True)
                digest=hashlib.sha256();size=0
                while True:
                    if time.monotonic()>=deadline: raise ImportObjectError("import_source_timeout")
                    chunk=body.read(1024*1024)
                    if not chunk: break
                    size+=len(chunk)
                    if size>file.size_bytes: raise ImportObjectError("import_size_mismatch",permanent=True)
                    digest.update(chunk)
                if size!=file.size_bytes or digest.hexdigest()!=file.sha256:
                    raise ImportObjectError("import_checksum_mismatch",permanent=True)
                if time.monotonic()>=deadline: raise ImportObjectError("import_source_timeout")
                etag=response.get("ETag","")
                if not 1<=len(etag)<=200: raise ImportObjectError("import_object_identity_missing",permanent=True)
                return VerifiedImportFile(file.role,size,digest.hexdigest(),etag)
            finally: body.close()
        except ClientError as error:
            status=error.response.get("ResponseMetadata",{}).get("HTTPStatusCode")
            raise ImportObjectError("import_upload_missing" if status==404 else "import_storage_unavailable") from None
        except BotoCoreError:
            raise ImportObjectError("import_storage_unavailable") from None

    @contextmanager
    def read_range(self,scope,import_id,file,*,offset,etag):
        if not 0<=offset<=file.size_bytes or not etag:
            raise ImportObjectError("import_invalid_checkpoint",permanent=True)
        body=None
        try:
            args={"Bucket":self.bucket,"Key":object_key(scope,import_id,file.role),"IfMatch":etag}
            if offset==file.size_bytes:
                response=self.client.head_object(**args)
                if response["ContentLength"]!=file.size_bytes:
                    raise ImportObjectError("import_source_changed",permanent=True)
                body=BytesIO()
            else:
                response=self.client.get_object(**args,Range=f"bytes={offset}-")
                body=response["Body"]
                expected=f"bytes {offset}-{file.size_bytes-1}/{file.size_bytes}"
                if response.get("ContentRange")!=expected or response["ContentLength"]!=file.size_bytes-offset:
                    raise ImportObjectError("import_source_changed",permanent=True)
            if response.get("ETag")!=etag: raise ImportObjectError("import_source_changed",permanent=True)
            yield body
        except ClientError as error:
            status=error.response.get("ResponseMetadata",{}).get("HTTPStatusCode")
            code="import_source_changed" if status in (404,412,416) else "import_storage_unavailable"
            raise ImportObjectError(code,permanent=status in (404,412,416)) from None
        except BotoCoreError:
            raise ImportObjectError("import_storage_unavailable") from None
        finally:
            if body is not None: body.close()
