# Contro1 AWS Lambda MicroVMs Connector

**AWS Lambda MicroVMs isolate AI-generated code. Contro1 governs the decision to run it.** This connector places an approval and audit layer in front of MicroVM lifecycle, endpoint token, and shell access APIs, so enterprises can safely run AI/user-generated code without giving agents direct cloud authority.

Repository description:

> Governed launcher and token broker for AWS Lambda MicroVMs, adding Contro1 approvals, audit evidence, and bypass detection for AI execution sandboxes.

Website: https://contro1.com

## What This Connector Does

The MVP is a **Governed MicroVM Launcher and Token Broker**. Agent runtimes and internal apps call this connector instead of calling AWS directly.

Governed actions:

- `RunMicrovm`
- `CreateMicrovmAuthToken`
- `CreateMicrovmShellAuthToken`
- `SuspendMicrovm`
- `ResumeMicrovm`
- `TerminateMicrovm`

Contro1 decides whether each action is auto-approved, routed to a human, or blocked. Every decision and AWS outcome is recorded as audit evidence.

## Why MicroVM Isolation Is Not Enough

MicroVMs are a strong sandbox primitive, but they do not answer the governance questions:

- Who launched this sandbox?
- Which AI agent or user requested it?
- Which image and execution role were used?
- Did it get internet or VPC access?
- Who approved shell access?
- Was the endpoint token scoped to one port and short-lived?
- What happened after approval?

AWS gives isolation. **Contro1 gives governed execution.**

## Threat Model

Contro1 is designed to prevent these common failure modes:

- Agent launches a sandbox with a production execution role.
- Agent requests shell access without owner approval.
- Developer creates a broad all-port auth token.
- AI coding agent runs unreviewed generated code.
- Long-running MicroVM keeps state without an audit trail.
- Unknown agent launches a MicroVM outside the approved registry.
- MicroVM gets internet or VPC access without human approval.

## Bypass Prevention

For Contro1 to be the control layer, it must be the only principal allowed to call high-risk MicroVM lifecycle and token APIs.

Production guidance:

- Agents do not get direct `lambda:RunMicrovm`.
- Developers do not get direct shell token permissions.
- Endpoint and shell tokens are issued only through Contro1.
- CloudTrail is used to detect direct calls outside Contro1.
- Any MicroVM without a `contro1_request_id` tag or hook payload is treated as unmanaged.

## Quick Start: TypeScript

```bash
cd examples/typescript
npm install
cp ../../.env.example .env
npm run dev
```

Start in mock AWS mode:

```bash
curl -X POST http://localhost:8091/microvms/run-request \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "agent-dev",
    "image_arn": "arn:aws:lambda:us-east-1:123456789012:microvm-image:agent-sandbox",
    "execution_role_arn": "arn:aws:iam::123456789012:role/MicrovmSandboxExecutionRole",
    "reason": "Run generated code in an isolated sandbox",
    "maximum_duration_seconds": 900,
    "network": { "egress": "none" },
    "shell_access": false
  }'
```

## Quick Start: Python

```bash
cd examples/python
python -m venv .venv
. .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp ../../.env.example .env
python app.py
```

## Policy Defaults

Auto-approve only when:

- agent is known
- image is allowed
- execution role is allowed and non-production
- shell access is false
- token is scoped to approved ports
- duration is short
- no VPC/private egress is requested

Require approval when:

- shell access is requested
- auth token is broad or long-lived
- VPC/private egress is requested
- production execution role is used
- duration is long
- image is new or AI-generated workflow is flagged

Block when:

- owner or agent is unknown
- agent is disabled
- shell plus production role is requested
- image is untagged or unmanaged
- execution role constraints are missing
- bypass indicators are present

## Event Taxonomy

The connector uses audit-first event names:

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

## Product Roadmap

The public connector proves the governed launcher pattern. The Contro1 product phase should add:

- AWS account settings: account id, role ARN, external id, region, allowed images, allowed roles.
- Unmanaged MicroVM discovery: list MicroVMs/images, find missing `contro1_request_id`, unknown owners, risky roles, shell-enabled sessions, broad tokens.
- Dashboard: MicroVM ID, agent, owner, image, execution role, network, shell, token scope, duration, approval status, evidence status, emergency terminate.
- Evidence packets: Contro1 request, reviewer, AWS params, AWS response, CloudTrail correlation, runtime events.

## Important Limitation

Contro1 cannot cleanly stop an already-running command inside a MicroVM unless the runtime or tool gateway is instrumented. The launcher governs lifecycle, endpoint tokens, and shell access. A future runtime shim governs bash, file, network, and tool calls after the MicroVM starts.

## Related Repositories

- https://github.com/contro1-hq/centcom
- https://github.com/contro1-hq/centcom-sdk
- https://github.com/contro1-hq/centcom-claude-code
- https://github.com/contro1-hq/centcom-claude-managed-agents
