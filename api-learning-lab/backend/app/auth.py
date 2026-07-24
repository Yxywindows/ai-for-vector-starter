"""
# ================================
# Header Example
#
# Headers carry metadata ABOUT the request — who is making it and in what
# context — never the resource data itself. That's the job of the body.
#
# This dependency simulates authentication (Authorization: Bearer <token>)
# and organization context (X-Organization-ID), for write operations only.
# The values are echoed back in responses purely so you can observe them.
# They are intentionally never used to filter or scope dataset rows —
# that would be conflating "who I am" with "what I'm asking for", which
# is exactly the mistake this lab wants you to avoid.
# ================================
"""
from fastapi import Header, HTTPException


class RequestContext:
    def __init__(self, token: str, organization_id: str):
        self.token = token
        self.organization_id = organization_id


def require_auth(
    authorization: str = Header(..., description="Bearer token, e.g. 'Bearer test-token'"),
    x_organization_id: str = Header(..., alias="X-Organization-ID", description="Simulated org context"),
) -> RequestContext:
    if not authorization.startswith("Bearer ") or len(authorization) <= len("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or malformed Authorization header. Expected: Bearer <token>")

    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Bearer token must not be empty")

    if not x_organization_id.strip():
        raise HTTPException(status_code=401, detail="X-Organization-ID header must not be empty")

    return RequestContext(token=token, organization_id=x_organization_id.strip())
