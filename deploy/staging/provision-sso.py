#!/usr/bin/env python3
"""Create the staging sign-in client in Authentik, and write it into .env.

One OIDC provider, one application, one redirect URI — the staging hostname
only. Idempotent: re-running reuses the provider, repairs a missing redirect URI
and leaves the client secret alone unless the provider is new, so nobody is
signed out by a redeploy.

Credential source, first match wins:
  AUTHENTIK_API_URL / AUTHENTIK_BOOTSTRAP_TOKEN in the environment
  AUTHENTIK_ENV_FILE, a dotenv-style file holding those two keys
  the estate's `cerulean` container, when this runs on an Incus host
Nothing is written anywhere except .env in this directory.

    python3 provision-sso.py            # create/repair, then update .env
    python3 provision-sso.py --check    # report only
"""
import json
import os
import re
import secrets
import subprocess
import sys
import urllib.error
import urllib.request

HOST = "fax-staging.lab.innotel.us"
PROVIDER_NAME = "Innotel Fax Staging"
APP_SLUG = "innotel-fax-staging"
APP_NAME = "Innotel Fax (staging)"
CLIENT_ID = "innotel-fax-staging"
REDIRECT_URI = f"https://{HOST}/auth/callback"
ENV_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
CHECK_ONLY = "--check" in sys.argv


def estate_env(key: str) -> str:
    if os.environ.get(key):
        return os.environ[key]

    env_file = os.environ.get("AUTHENTIK_ENV_FILE")
    if env_file and os.path.exists(env_file):
        for line in open(env_file, encoding="utf-8"):
            match = re.match(rf"^{key}=(.+)$", line.strip())
            if match:
                return match.group(1).strip().strip('"').strip("'")

    try:
        out = subprocess.run(
            [
                "incus", "exec", "proxy", "--", "docker", "exec", "cerulean",
                "printenv", key,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        value = out.stdout.strip() if out.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        value = ""

    if not value:
        sys.exit(
            f"provision-sso: {key} is not set. Export it, point AUTHENTIK_ENV_FILE at a "
            "file holding it, or run this on the Incus host that runs the proxy container."
        )
    return value


API = estate_env("AUTHENTIK_API_URL").rstrip("/")
if not API.endswith("/api/v3"):
    API += "/api/v3"
TOKEN = estate_env("AUTHENTIK_BOOTSTRAP_TOKEN")
ISSUER = API.rsplit("/api/v3", 1)[0] + f"/application/o/{APP_SLUG}/"


def call(path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(API + path, data=data, method=method)
    request.add_header("Authorization", "Bearer " + TOKEN)
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode()
            return json.loads(raw) if raw.strip() else None
    except urllib.error.HTTPError as error:
        sys.exit(f"provision-sso: {method} {path} -> HTTP {error.code}: {error.read().decode()[:400]}")


def one(path: str, **params):
    query = "&".join(f"{key}={value}" for key, value in params.items())
    results = call(f"{path}?{query}")["results"]
    if not results:
        sys.exit(f"provision-sso: nothing found for {path}?{query}")
    return results[0]


def find_provider():
    for provider in call("/providers/oauth2/?page_size=200")["results"]:
        if provider["name"] == PROVIDER_NAME:
            return provider
    return None


def find_app():
    for application in call("/core/applications/?page_size=200")["results"]:
        if application["slug"] == APP_SLUG:
            return application
    return None


# Flows, signing key and scope mappings are looked up, not hard-coded: the IDs
# differ between Authentik installs and change when a flow is recreated.
authorization_flow = one("/flows/instances/", slug="default-provider-authorization-explicit-consent")["pk"]
invalidation_flow = one("/flows/instances/", slug="default-provider-invalidation-flow")["pk"]
signing_key = call("/crypto/certificatekeypairs/?page_size=50")["results"][0]["pk"]

# Prefer the estate's email mapping (which reports email_verified: true) over
# Authentik's stock one, which sends false and breaks strict OIDC clients.
mappings = []
by_scope = {}
for mapping in call("/propertymappings/provider/scope/?page_size=200")["results"]:
    scope = (mapping.get("scope_name") or "").lower()
    by_scope.setdefault(scope, []).append(mapping)
for scope in ("openid", "email", "profile", "groups"):
    options = by_scope.get(scope) or []
    if not options:
        continue
    verified = [m for m in options if "email_verified" in (m.get("expression") or "") and "True" in (m.get("expression") or "")]
    chosen = (verified or options)[0]
    mappings.append(chosen["pk"])

provider = find_provider()
if provider is None:
    if CHECK_ONLY:
        print(f"check: provider {PROVIDER_NAME!r} is missing")
        sys.exit(1)
    provider = call(
        "/providers/oauth2/",
        "POST",
        {
            "name": PROVIDER_NAME,
            "authorization_flow": authorization_flow,
            "invalidation_flow": invalidation_flow,
            "client_type": "confidential",
            "client_id": CLIENT_ID,
            "client_secret": secrets.token_urlsafe(64),
            "property_mappings": mappings,
            "redirect_uris": [
                {"matching_mode": "strict", "url": REDIRECT_URI, "redirect_uri_type": "authorization"}
            ],
            "signing_key": signing_key,
            "grant_types": ["authorization_code", "refresh_token"],
            "include_claims_in_id_token": True,
            "sub_mode": "hashed_user_id",
            "issuer_mode": "per_provider",
            "access_code_validity": "minutes=5",
            "access_token_validity": "minutes=60",
        },
    )
    print(f"provider created: pk={provider['pk']} client_id={provider['client_id']}")
else:
    uris = [uri["url"] for uri in provider.get("redirect_uris") or []]
    patch = {}
    if REDIRECT_URI not in uris:
        patch["redirect_uris"] = list(provider.get("redirect_uris") or []) + [
            {"matching_mode": "strict", "url": REDIRECT_URI, "redirect_uri_type": "authorization"}
        ]
    missing = [pk for pk in mappings if pk not in (provider.get("property_mappings") or [])]
    if missing:
        patch["property_mappings"] = list(provider.get("property_mappings") or []) + missing
    if "authorization_code" not in (provider.get("grant_types") or []):
        patch["grant_types"] = list(provider.get("grant_types") or []) + ["authorization_code", "refresh_token"]
    if patch and not CHECK_ONLY:
        provider = call(f"/providers/oauth2/{provider['pk']}/", "PATCH", patch)
        print(f"provider repaired: {sorted(patch)}")
    print(f"provider exists: pk={provider['pk']} client_id={provider['client_id']}")

application = find_app()
if application is None:
    if CHECK_ONLY:
        print(f"check: application {APP_SLUG!r} is missing")
        sys.exit(1)
    application = call(
        "/core/applications/",
        "POST",
        {
            "name": APP_NAME,
            "slug": APP_SLUG,
            "provider": provider["pk"],
            "meta_launch_url": f"https://{HOST}/",
            "policy_engine_mode": "any",
            "open_in_new_tab": False,
        },
    )
    print(f"application created: slug={application['slug']}")
else:
    print(f"application exists: slug={application['slug']}")

if CHECK_ONLY:
    print(f"check: ok — issuer {ISSUER}")
    sys.exit(0)

# Rewrite only the three lines this script owns, so a redeploy does not discard
# a session secret somebody set by hand.
lines = []
if os.path.exists(ENV_FILE):
    with open(ENV_FILE, encoding="utf-8") as handle:
        lines = handle.read().splitlines()
owned = {
    "FAX_OIDC_ISSUER": ISSUER,
    "FAX_OIDC_CLIENT_ID": provider["client_id"],
    "FAX_OIDC_CLIENT_SECRET": provider["client_secret"],
}
seen = set()
updated = []
for line in lines:
    match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=", line)
    if match and match.group(1) in owned:
        key = match.group(1)
        updated.append(f"{key}={owned[key]}")
        seen.add(key)
    else:
        updated.append(line)
for key, value in owned.items():
    if key not in seen:
        updated.append(f"{key}={value}")
with open(ENV_FILE, "w", encoding="utf-8") as handle:
    handle.write("\n".join(updated) + "\n")
os.chmod(ENV_FILE, 0o600)
print(f"wrote {ENV_FILE}: issuer, client id and secret")
print(f"issuer: {ISSUER}")
print(f"redirect uri: {REDIRECT_URI}")
