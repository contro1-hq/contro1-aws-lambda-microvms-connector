"""Contro1 governed launcher and token broker for AWS Lambda MicroVMs.

Runs in mock AWS mode by default. Set SIMULATE_AWS=false once your boto3
version exposes the Lambda MicroVM APIs in your AWS region/account.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from typing import Any, Literal

import boto3
from centcom import CentcomClient
from dotenv import load_dotenv
from flask import Flask, jsonify, request

load_dotenv()

Decision = Literal["auto_approve", "require_approval", "block"]
ActionType = Literal["run_microvm", "create_auth_token", "create_shell_token", "suspend", "resume", "terminate"]

EVENT = {
    "run_requested": "aws.microvm.run.requested",
    "run_approved": "aws.microvm.run.approved",
    "run_denied": "aws.microvm.run.denied",
    "run_created": "aws.microvm.run.created",
    "auth_token_requested": "aws.microvm.auth_token.requested",
    "auth_token_issued": "aws.microvm.auth_token.issued",
    "shell_token_requested": "aws.microvm.shell_token.requested",
    "shell_token_approved": "aws.microvm.shell_token.approved",
    "shell_token_denied": "aws.microvm.shell_token.denied",
    "suspend_requested": "aws.microvm.suspend.requested",
    "resume_requested": "aws.microvm.resume.requested",
    "terminate_requested": "aws.microvm.terminate.requested",
    "bypass_detected": "aws.microvm.bypass.detected",
    "unmanaged_detected": "aws.microvm.unmanaged.detected",
}

app = Flask(__name__)

PORT = int(os.getenv("LISTENER_PORT", "8091"))
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", f"http://localhost:{PORT}").rstrip("/")
SIMULATE_AWS = os.getenv("SIMULATE_AWS", "true").lower() != "false"
CALLBACK_MAX_SKEW_SECONDS = int(os.getenv("CALLBACK_MAX_SKEW_SECONDS", "300"))
MAX_AUTO_APPROVE_DURATION_SECONDS = int(os.getenv("MAX_AUTO_APPROVE_DURATION_SECONDS", "1800"))
MAX_TOKEN_TTL_SECONDS = int(os.getenv("MAX_TOKEN_TTL_SECONDS", "900"))
DEFAULT_REQUIRED_ROLE = os.getenv("DEFAULT_REQUIRED_ROLE", "security")
DEFAULT_SLA_MINUTES = int(os.getenv("DEFAULT_SLA_MINUTES", "10"))

ALLOWED_AGENT_IDS = set(filter(None, (v.strip() for v in os.getenv("ALLOWED_AGENT_IDS", "").split(","))))
ALLOWED_IMAGE_ARNS = set(filter(None, (v.strip() for v in os.getenv("ALLOWED_IMAGE_ARNS", "").split(","))))
ALLOWED_EXECUTION_ROLE_ARNS = set(filter(None, (v.strip() for v in os.getenv("ALLOWED_EXECUTION_ROLE_ARNS", "").split(","))))
PRODUCTION_EXECUTION_ROLE_ARNS = set(filter(None, (v.strip() for v in os.getenv("PRODUCTION_EXECUTION_ROLE_ARNS", "").split(","))))
ALLOWED_TOKEN_PORTS = set(int(v.strip()) for v in os.getenv("ALLOWED_TOKEN_PORTS", "8080,8443").split(",") if v.strip())

centcom = CentcomClient(
    api_key=os.getenv("CONTRO1_API_KEY", "cc_missing_for_local_mock"),
    base_url=os.getenv("CONTRO1_BASE_URL", "https://api.contro1.com/api/centcom/v1"),
)
lambda_client = boto3.client("lambda", region_name=os.getenv("AWS_REGION", "us-east-1"))

pending_by_request_id: dict[str, dict[str, Any]] = {}
pending_by_external_id: dict[str, dict[str, Any]] = {}


def stable_hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def external_request_id(payload: dict[str, Any]) -> str:
    return ":".join(
        [
            "aws-microvm",
            str(payload.get("action_type")),
            str(payload.get("agent_id") or "unknown-agent"),
            str(payload.get("microvm_id") or stable_hash(payload.get("image_arn") or "no-image")),
            stable_hash(
                {
                    "image_arn": payload.get("image_arn"),
                    "execution_role_arn": payload.get("execution_role_arn"),
                    "duration": payload.get("maximum_duration_seconds"),
                    "ports": payload.get("ports"),
                    "token_ttl_seconds": payload.get("token_ttl_seconds"),
                    "shell_access": payload.get("shell_access"),
                }
            ),
        ]
    )


def classify(payload: dict[str, Any]) -> dict[str, str]:
    action = str(payload.get("action_type"))
    agent_id = str(payload.get("agent_id") or "")
    if agent_id not in ALLOWED_AGENT_IDS:
        return {"decision": "block", "risk": "critical", "rule_id": "unknown-agent", "reason": "Unknown or unapproved agent cannot manage MicroVMs."}
    if action == "run_microvm" and not payload.get("owner"):
        return {"decision": "block", "risk": "critical", "rule_id": "missing-owner", "reason": "MicroVM launch requires an accountable owner."}

    if action == "run_microvm":
        image_arn = str(payload.get("image_arn") or "")
        role_arn = str(payload.get("execution_role_arn") or "")
        if image_arn not in ALLOWED_IMAGE_ARNS:
            return {"decision": "require_approval", "risk": "high", "rule_id": "new-or-unapproved-image", "reason": "MicroVM image is not in the approved registry."}
        if role_arn not in ALLOWED_EXECUTION_ROLE_ARNS:
            return {"decision": "block", "risk": "critical", "rule_id": "unapproved-execution-role", "reason": "Execution role is missing or not constrained for MicroVM use."}
        if role_arn in PRODUCTION_EXECUTION_ROLE_ARNS and payload.get("shell_access"):
            return {"decision": "block", "risk": "critical", "rule_id": "shell-plus-production", "reason": "Shell access with production execution role is blocked."}
        if role_arn in PRODUCTION_EXECUTION_ROLE_ARNS:
            return {"decision": "require_approval", "risk": "high", "rule_id": "production-execution-role", "reason": "Production execution role requires human approval."}
        if payload.get("shell_access"):
            return {"decision": "require_approval", "risk": "high", "rule_id": "shell-requested", "reason": "Shell access always requires human approval."}
        if (payload.get("network") or {}).get("egress") not in {None, "", "none"}:
            return {"decision": "require_approval", "risk": "high", "rule_id": "network-egress", "reason": "Internet, VPC, or private egress requires human approval."}
        if int(payload.get("maximum_duration_seconds") or 0) > MAX_AUTO_APPROVE_DURATION_SECONDS:
            return {"decision": "require_approval", "risk": "medium", "rule_id": "long-duration", "reason": "Requested duration exceeds auto-approval limit."}
        return {"decision": "auto_approve", "risk": "low", "rule_id": "known-low-risk-launch", "reason": "Known agent, image, role, no shell, and short duration."}

    if action == "create_shell_token":
        return {"decision": "require_approval", "risk": "high", "rule_id": "shell-token", "reason": "Shell token issuance always requires approval."}
    if action == "create_auth_token":
        ports = payload.get("ports") or []
        ttl = int(payload.get("token_ttl_seconds") or 0)
        if not ports or any(int(port) not in ALLOWED_TOKEN_PORTS for port in ports) or ttl > MAX_TOKEN_TTL_SECONDS:
            return {"decision": "require_approval", "risk": "high", "rule_id": "broad-or-long-token", "reason": "Endpoint token is broad, unscoped, or long-lived."}
        return {"decision": "auto_approve", "risk": "low", "rule_id": "scoped-short-token", "reason": "Endpoint token is scoped to approved ports and short-lived."}
    if action == "terminate":
        return {"decision": "auto_approve", "risk": "medium", "rule_id": "emergency-control", "reason": "Terminate is an emergency control and is audit logged."}
    return {"decision": "require_approval", "risk": "medium", "rule_id": f"{action}-review", "reason": f"MicroVM {action} requires review."}


def aws_input_for(payload: dict[str, Any]) -> dict[str, Any]:
    action = payload["action_type"]
    if action == "run_microvm":
        return {
            "ImageIdentifier": payload.get("image_arn"),
            "ExecutionRoleArn": payload.get("execution_role_arn"),
            "MaximumDurationInSeconds": payload.get("maximum_duration_seconds"),
            "RunHookPayload": {
                "contro1_request_id": (payload.get("metadata") or {}).get("contro1_request_id"),
                "agent_id": payload.get("agent_id"),
                "owner": payload.get("owner"),
                "correlation_id": payload.get("correlation_id"),
            },
        }
    if action == "create_auth_token":
        return {"MicrovmId": payload.get("microvm_id"), "Ports": payload.get("ports"), "TimeToLiveInSeconds": payload.get("token_ttl_seconds")}
    if action == "create_shell_token":
        return {"MicrovmId": payload.get("microvm_id"), "TimeToLiveInSeconds": payload.get("token_ttl_seconds", 900)}
    return {"MicrovmId": payload.get("microvm_id")}


def call_aws(payload: dict[str, Any], aws_input: dict[str, Any]) -> dict[str, Any]:
    if SIMULATE_AWS:
        return {
            "simulated": True,
            "action_type": payload["action_type"],
            "microvm_id": payload.get("microvm_id") or f"mvm_{stable_hash(aws_input)}",
            "endpoint": f"https://mvm-{stable_hash(aws_input)}.lambda-microvm.local" if payload["action_type"] == "run_microvm" else None,
            "token": f"mock_token_{stable_hash(aws_input)}" if "token" in payload["action_type"] else None,
        }

    method_by_action = {
        "run_microvm": "run_microvm",
        "create_auth_token": "create_microvm_auth_token",
        "create_shell_token": "create_microvm_shell_auth_token",
        "suspend": "suspend_microvm",
        "resume": "resume_microvm",
        "terminate": "terminate_microvm",
    }
    method_name = method_by_action[payload["action_type"]]
    method = getattr(lambda_client, method_name, None)
    if method is None:
        raise RuntimeError(f"Installed boto3 does not expose lambda.{method_name} yet. Upgrade boto3 or set SIMULATE_AWS=true.")
    return method(**aws_input)


def log_action(action: str, summary: str, payload: dict[str, Any], outcome: str = "success", metadata: dict[str, Any] | None = None) -> None:
    try:
        centcom.log_action(
            action=action,
            summary=summary,
            source={"integration": "aws-lambda-microvms", "workflow_id": "microvm-launcher"},
            actor={"agent_id": payload.get("agent_id")},
            resource={"type": "aws.lambda.microvm", "id": payload.get("microvm_id"), "uri": payload.get("image_arn")},
            outcome=outcome,
            severity="info" if outcome == "success" else "warning",
            correlation_id=payload.get("correlation_id"),
            external_request_id=external_request_id(payload),
            metadata={**(payload.get("metadata") or {}), **(metadata or {})},
        )
    except Exception as error:  # noqa: BLE001
        app.logger.warning("Could not write Contro1 audit record: %s", error)


def create_approval(payload: dict[str, Any], aws_input: dict[str, Any], policy: dict[str, str]) -> dict[str, Any]:
    ext_id = external_request_id(payload)
    existing = pending_by_external_id.get(ext_id)
    if existing:
        return {"status": "pending_approval", "request_id": existing["request_id"], "external_request_id": ext_id, "duplicate": True}

    created = centcom.create_protocol_request(
        {
            "title": f"Approve AWS Lambda MicroVM action: {payload['action_type']}",
            "description": policy["reason"],
            "request_type": "approval",
            "source": {
                "integration": "aws-lambda-microvms",
                "framework": "aws-lambda",
                "workflow_id": "microvm-launcher",
                "run_id": ext_id,
            },
            "routing": {
                "required_role": DEFAULT_REQUIRED_ROLE,
                "priority": "urgent" if policy["risk"] in {"high", "critical"} else "normal",
                "sla_minutes": DEFAULT_SLA_MINUTES,
            },
            "actor": {"agent_id": payload.get("agent_id")},
            "context": {
                "action_type": payload["action_type"],
                "resource": payload.get("image_arn") or payload.get("microvm_id"),
                "environment": payload.get("environment") or "sandbox",
                "summary": payload.get("reason") or policy["reason"],
                "tool_input": aws_input,
            },
            "continuation": {"mode": "decision", "webhook_url": f"{PUBLIC_BASE_URL}/contro1/callback"},
            "risk_level": policy["risk"],
            "policy_trigger": policy["reason"],
            "policy_context": {
                "source": "aws_lambda_microvms_connector",
                "policy_name": "microvm-launcher-policy",
                "rule_id": policy["rule_id"],
                "rule_reason": policy["reason"],
                "enforcement": "require_approval",
            },
            "approval_comment_required": policy["risk"] in {"high", "critical"} or payload["action_type"] == "create_shell_token",
            "external_request_id": ext_id,
            "correlation_id": payload.get("correlation_id") or payload.get("microvm_id") or payload.get("agent_id"),
            "metadata": {"awsInput": aws_input},
        }
    )
    request_id = str(created.get("id") or created.get("request_id") or "")
    pending = {"request_id": request_id, "external_request_id": ext_id, "original": payload, "aws_input": aws_input}
    pending_by_request_id[request_id] = pending
    pending_by_external_id[ext_id] = pending
    return {"status": "pending_approval", "request_id": request_id, "external_request_id": ext_id}


def handle_action(payload: dict[str, Any]) -> dict[str, Any]:
    policy = classify(payload)
    aws_input = aws_input_for(payload)
    requested_event = {
        "run_microvm": EVENT["run_requested"],
        "create_auth_token": EVENT["auth_token_requested"],
        "create_shell_token": EVENT["shell_token_requested"],
        "suspend": EVENT["suspend_requested"],
        "resume": EVENT["resume_requested"],
        "terminate": EVENT["terminate_requested"],
    }[payload["action_type"]]
    log_action(requested_event, policy["reason"], payload, metadata={"policy": policy})

    if policy["decision"] == "block":
        log_action(EVENT["run_denied"] if payload["action_type"] == "run_microvm" else f"{requested_event}.blocked", policy["reason"], payload, "failure", {"policy": policy})
        return {"status": "blocked", "policy": policy}
    if policy["decision"] == "require_approval":
        return create_approval(payload, aws_input, policy)

    aws = call_aws(payload, aws_input)
    event_name = EVENT["run_created"] if payload["action_type"] == "run_microvm" else EVENT["auth_token_issued"] if payload["action_type"] == "create_auth_token" else requested_event
    log_action(event_name, f"AWS Lambda MicroVM action {payload['action_type']} completed.", payload, metadata={"aws": aws, "policy": policy})
    return {"status": "approved", "decision": "auto_approved", "aws": aws}


@app.post("/microvms/run-request")
def run_request():
    payload = dict(request.get_json(force=True) or {})
    payload["action_type"] = "run_microvm"
    return jsonify(handle_action(payload))


@app.post("/microvms/<microvm_id>/auth-token-request")
def auth_token_request(microvm_id: str):
    payload = dict(request.get_json(force=True) or {})
    payload["microvm_id"] = microvm_id
    payload["action_type"] = "create_auth_token"
    return jsonify(handle_action(payload))


@app.post("/microvms/<microvm_id>/shell-token-request")
def shell_token_request(microvm_id: str):
    payload = dict(request.get_json(force=True) or {})
    payload["microvm_id"] = microvm_id
    payload["action_type"] = "create_shell_token"
    return jsonify(handle_action(payload))


@app.post("/microvms/<microvm_id>/<action>")
def lifecycle_request(microvm_id: str, action: str):
    if action not in {"suspend", "resume", "terminate"}:
        return jsonify({"error": "unsupported_action"}), 404
    payload = dict(request.get_json(force=True) or {})
    payload["microvm_id"] = microvm_id
    payload["action_type"] = action
    return jsonify(handle_action(payload))


@app.post("/discovery/unmanaged")
def unmanaged_discovery():
    payload = dict(request.get_json(force=True) or {})
    log_action(
        EVENT["bypass_detected"] if payload.get("bypass") else EVENT["unmanaged_detected"],
        payload.get("summary") or "Detected unmanaged or bypassed AWS Lambda MicroVM activity.",
        {"action_type": "run_microvm", "agent_id": payload.get("agent_id") or "unknown", "microvm_id": payload.get("microvm_id"), "correlation_id": payload.get("correlation_id")},
        "failure",
        payload,
    )
    return jsonify({"status": "logged"})


def verify_callback(raw_body: bytes) -> bool:
    secret = os.getenv("CONTRO1_WEBHOOK_SECRET", "")
    signature = request.headers.get("X-CentCom-Signature", "")
    timestamp = request.headers.get("X-CentCom-Timestamp", "")
    if not secret or not signature or not timestamp:
        return False
    try:
        timestamp_int = int(timestamp)
    except ValueError:
        return False
    if abs(int(time.time()) - timestamp_int) > CALLBACK_MAX_SKEW_SECONDS:
        return False
    expected = hmac.new(secret.encode("utf-8"), f"{timestamp}.{raw_body.decode('utf-8')}".encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


@app.post("/contro1/callback")
def contro1_callback():
    raw_body = request.get_data(cache=True)
    if not verify_callback(raw_body):
        return jsonify({"error": "invalid_signature"}), 401
    payload = request.get_json(force=True) or {}
    request_id = str(payload.get("request_id") or (payload.get("protocol_response") or {}).get("request_id") or "")
    status = str(payload.get("status") or (payload.get("protocol_response") or {}).get("status") or "")
    pending = pending_by_request_id.get(request_id)
    if not pending:
        return jsonify({"error": "unknown_request_id"}), 404

    original = pending["original"]
    if status != "approved":
        event_name = EVENT["shell_token_denied"] if original["action_type"] == "create_shell_token" else EVENT["run_denied"]
        log_action(event_name, f"Contro1 denied or closed {original['action_type']}: {status}", original, "failure", {"callback": payload})
        return jsonify({"status": "denied", "request_id": request_id})

    aws = call_aws(original, pending["aws_input"])
    event_name = EVENT["run_created"] if original["action_type"] == "run_microvm" else EVENT["auth_token_issued"] if original["action_type"] == "create_auth_token" else EVENT["shell_token_approved"] if original["action_type"] == "create_shell_token" else f"{original['action_type']}.approved"
    log_action(event_name, f"Approved AWS Lambda MicroVM action {original['action_type']} completed.", original, metadata={"callback": payload, "aws": aws})
    pending_by_request_id.pop(request_id, None)
    pending_by_external_id.pop(pending["external_request_id"], None)
    return jsonify({"status": "executed", "request_id": request_id, "aws": aws})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=True)
