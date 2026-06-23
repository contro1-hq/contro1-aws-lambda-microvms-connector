---
name: contro1-aws-lambda-microvms
description: Add Contro1 governed launch, token brokerage, shell approval, bypass detection, and audit evidence to AWS Lambda MicroVM execution environments.
---

# Contro1 AWS Lambda MicroVMs Skill

Use this skill when integrating Contro1 with AWS Lambda MicroVMs or AI execution sandboxes that use MicroVM lifecycle/token APIs.

## Positioning

AWS Lambda MicroVMs isolate AI-generated code. Contro1 governs the decision to run it.

Start with a **Governed MicroVM Launcher and Token Broker**, not a runtime shim. Put Contro1 before:

- `RunMicrovm`
- `CreateMicrovmAuthToken`
- `CreateMicrovmShellAuthToken`
- `SuspendMicrovm`
- `ResumeMicrovm`
- `TerminateMicrovm`

## Required Discovery

Before coding in a customer repo, inspect:

- where agents or apps launch sandboxes
- whether AWS credentials can call MicroVM APIs directly
- how agent identity, owner, tenant, environment, and session id are represented
- whether shell, internet egress, VPC access, or production roles are possible
- where audit logs and webhook callbacks can be stored

## Integration Rules

- Do not give agents direct IAM permission for high-risk MicroVM APIs.
- Route lifecycle and token requests through Contro1.
- Use deterministic `external_request_id` values for idempotency.
- Use `correlation_id` to group the full sandbox session.
- Require approval for shell access.
- Fail closed on timeout, invalid callback, unknown owner, or unknown agent.
- Log autonomous allowed actions as audit records.
- Detect direct AWS calls as bypass events.

## Protocol Mapping

Use:

- `source.integration = "aws-lambda-microvms"`
- `context.action_type = "run_microvm" | "create_auth_token" | "create_shell_token" | "suspend" | "resume" | "terminate"`
- `policy_context.source = "aws_lambda_microvms_connector"`
- `approval_comment_required = true` for shell, production roles, broad tokens, and VPC/private egress

## Event Names

Use these audit actions:

```text
aws.microvm.run.requested
aws.microvm.run.approved
aws.microvm.run.denied
aws.microvm.run.created
aws.microvm.auth_token.requested
aws.microvm.auth_token.issued
aws.microvm.shell_token.requested
aws.microvm.shell_token.approved
aws.microvm.shell_token.denied
aws.microvm.suspend.requested
aws.microvm.resume.requested
aws.microvm.terminate.requested
aws.microvm.bypass.detected
aws.microvm.unmanaged.detected
```

## Policy Defaults

Auto-approve only if the agent, image, and execution role are known; shell is disabled; token ports are scoped; duration is short; and the request is not production or private-network access.

Require approval for shell, production roles, broad/all-port tokens, VPC/private egress, internet egress with sensitive context, long duration, or new images.

Block unknown agents, missing owners, disabled agents, unmanaged images, shell plus production role, missing execution role constraints, and bypass indicators.

## Final Report

When done, report:

- which AWS actions now go through Contro1
- which IAM permissions must be removed from agents/developers
- approval policy defaults
- audit event names added
- callback/signature verification status
- smoke tests performed
- remaining limitation: existing in-VM commands need a runtime shim/tool gateway for clean command-level control
