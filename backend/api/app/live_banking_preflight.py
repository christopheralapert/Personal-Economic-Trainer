"""Credential-safe readiness checks. No consent, account or payment operations."""
from .live_banking_provider import EnableBankingClient, LiveProviderError
from .settings import Settings


class MetadataOnlyClient(EnableBankingClient):
    """An additional boundary for operator checks, even when live access is off."""

    def request(self, method, path, *, params=None, body=None):
        if method != "GET" or path not in ("/application", "/aspsps") or body is not None:
            raise LiveProviderError("BANK_PREFLIGHT_METADATA_ONLY")
        return super().request(method, path, params=params)


def preflight(settings: Settings, *, directory=False, transport=None):
    required = {
        "MONEYLENS_ENABLE_BANKING_APP_ID": settings.enable_banking_app_id,
        "MONEYLENS_ENABLE_BANKING_PRIVATE_KEY_PEM": settings.enable_banking_private_key_pem,
        "MONEYLENS_LIVE_BANKING_CIPHER_KEY": settings.live_banking_cipher_key,
    }
    report = {
        "live_banking_enabled": settings.live_banking_enabled,
        "environment": settings.enable_banking_environment,
        "callback": settings.app_origin + "/api/v1/live-banking/callback",
        "missing_settings": [name for name, value in required.items() if not value],
        "configuration_valid": False,
        "provider_checked": False,
        "restricted_account_links": "not_exposed_by_provider_metadata",
        "bank_authorization_started": False,
        "personal_data_read": False,
    }
    if report["missing_settings"]:
        return report
    try:
        # Validate the complete enabled configuration without changing runtime flags.
        Settings(**(settings.model_dump() | {"live_banking_enabled": True}))
    except ValueError:
        report["error"] = "BANK_CONFIGURATION_INVALID"
        return report
    report["configuration_valid"] = True
    if not directory:
        return report

    def client():
        return MetadataOnlyClient(
            settings.enable_banking_app_id,
            settings.enable_banking_private_key_pem.get_secret_value(),
            expected_environment=settings.enable_banking_environment,
            transport=transport,
        )

    try:
        client().application(report["callback"])
        report["application_verified"] = True
        countries = {}
        for country in ("EE", "FI", "LV", "LT", "SE"):
            # Each bounded request has its own deadline. No retries or bank reads.
            banks = client().institutions(country)
            countries[country] = {
                "personal_institution_count": len(banks),
                "requested_banks": [bank for bank in banks if any(
                    name in bank["name"].casefold()
                    for name in ("wise", "luminor", "swedbank", "seb", "lhv", "s-pankki")
                )],
            }
        report["directory"] = countries
        report["provider_checked"] = True
    except LiveProviderError as error:
        # Never return raw provider bodies, JWTs, credentials or personal data.
        report["error"] = error.code
    return report
