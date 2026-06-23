# Contro1 AWS Lambda MicroVMs Connector

**AWS Lambda MicroVMs isolate AI-generated code. Contro1 governs the decision to run it.** This connector places an approval and audit layer in front of MicroVM lifecycle, endpoint token, and shell access APIs, so enterprises can safely run AI/user-generated code without giving agents direct cloud authority.

Repository description:

> Governed launcher and token broker for AWS Lambda MicroVMs, adding Contro1 approvals, audit evidence, and bypass detection for AI execution sandboxes.

## Links

- Website: https://contro1.com
- Documentation: https://contro1.com/docs
- Agent Integration Kit: https://contro1.com/agent-kit

## What This Connector Does

This connector is the small server in this repository. You deploy it in your own cloud account or hosting environment. Agent runtimes and internal apps call this server instead of calling AWS directly.

The server acts as a **Governed MicroVM Launcher and Token Broker**. It checks each request, asks Contro1 for approval when needed, and only then calls AWS.

Governed actions:

- `RunMicrovm`
- `CreateMicrovmAuthToken`
- `CreateMicrovmShellAuthToken`
- `SuspendMicrovm`
- `ResumeMicrovm`
- `TerminateMicrovm`

Contro1 decides whether each action is auto-approved, routed to a human, or blocked. Every decision and AWS outcome is recorded as audit evidence.

## What You Need To Prepare

You can read the guide and run the examples in mock mode without any AWS setup. For a real deployment, there are three pieces:

1. **Contro1** routes the approval decision and sends a signed approval response.
2. **This connector** is the server from this repo. It receives the signed answer and then calls AWS.
3. **AWS** runs the MicroVM and issues endpoint or shell tokens.

This deployed server is the bridge between Contro1 and AWS. You run it in your own environment.

### In Contro1

- Create a Contro1 account and organization.
- Open **Settings -> APIs & Webhooks**.
- Create a Contro1 API key named something like `Lambda MicroVMs connector`.
- Copy the API key value into the deployed server environment as `CONTRO1_API_KEY`.
- Reveal or rotate the organization webhook secret.
- Copy the webhook secret into the deployed server environment as `CONTRO1_WEBHOOK_SECRET`.
- Choose where approvals go in Contro1: dashboard, Slack, Microsoft Teams, or your configured operator workflow.
- Define the reviewer role for high-risk MicroVM actions, for example `security`, `platform`, or `cloud-admin`.
- Decide who reviews requests from this API key. You can use API key routing, departments, roles, Slack, Teams, and SLA settings.
- Keep the connector API key and webhook secret outside source control.

### In Your Connector Deployment

Deploy this repository as a small HTTPS server. It can run on Cloud Run, ECS, Fly.io, Render, a VM, Kubernetes, or any HTTPS service host.

The flow is:

1. Your agent calls this connector, for example `POST /microvms/run-request`.
2. The connector checks the request against its policy.
3. If a human must approve, the connector creates a Contro1 request.
4. In that request, the connector includes the address where Contro1 should send the answer: `https://your-connector-host/contro1/callback`.
5. The operator approves or denies in Contro1, Slack, or Teams.
6. Contro1 sends a signed POST to `/contro1/callback` on your connector.
7. The connector verifies the signature with `CONTRO1_WEBHOOK_SECRET`.
8. If approved, the connector calls AWS. If denied or invalid, it does not call AWS.

Set these environment variables on the deployed server:

```bash
CONTRO1_API_KEY=cc_live_...
CONTRO1_WEBHOOK_SECRET=whsec_...
PUBLIC_BASE_URL=https://your-connector-host.example.com
```

`PUBLIC_BASE_URL` is simply where this server is hosted. If `PUBLIC_BASE_URL=https://microvms.example.com`, the server tells Contro1 to send the approval answer to `https://microvms.example.com/contro1/callback`.

For local testing with real approval answers from Contro1, expose your local server with a tunnel such as ngrok or Cloudflare Tunnel and use that tunnel URL as `PUBLIC_BASE_URL`.

The policy for this server lives in environment variables or your deployment config:

- `ALLOWED_AGENT_IDS`: which agents may request MicroVMs
- `ALLOWED_IMAGE_ARNS`: which MicroVM images are approved
- `ALLOWED_EXECUTION_ROLE_ARNS`: which execution roles are allowed
- `PRODUCTION_EXECUTION_ROLE_ARNS`: roles that require stricter review
- `ALLOWED_TOKEN_PORTS`: ports that can receive endpoint tokens
- `MAX_AUTO_APPROVE_DURATION_SECONDS`: longest launch allowed without review
- `MAX_TOKEN_TTL_SECONDS`: longest endpoint token allowed without review

### In AWS

- Confirm AWS Lambda MicroVMs is available in your AWS account and target region.
- Create or select the MicroVM image your agents are allowed to run.
- Create a dedicated IAM role for the Contro1 connector/launcher.
- Give that connector role the minimum required MicroVM permissions:
  - `lambda:RunMicrovm`
  - `lambda:GetMicrovm`
  - `lambda:ListMicrovms`
  - `lambda:SuspendMicrovm`
  - `lambda:ResumeMicrovm`
  - `lambda:TerminateMicrovm`
  - `lambda:CreateMicrovmAuthToken`
  - `lambda:CreateMicrovmShellAuthToken` if shell is enabled
- Create constrained MicroVM execution roles for the workloads themselves.
- Remove direct MicroVM lifecycle and token permissions from agents, developers, and CI jobs that should be governed by Contro1.
- Enable CloudTrail logging for MicroVM API activity so direct bypass calls can be detected.
- Enable CloudWatch/runtime logging for the MicroVM execution role if you need runtime evidence.
- Tag or pass metadata such as `contro1_request_id`, agent id, owner, environment, and correlation id.

### Connector Environment

Start with `SIMULATE_AWS=true` for local testing. In that mode, `PUBLIC_BASE_URL` can be a local tunnel URL such as ngrok or Cloudflare Tunnel if you want to test real approval answers from Contro1.

Switch to `SIMULATE_AWS=false` only after AWS credentials, IAM roles, images, and SDK support are ready.

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

## Important Limitation

Contro1 cannot cleanly stop an already-running command inside a MicroVM unless the runtime or tool gateway is instrumented. The launcher governs lifecycle, endpoint tokens, and shell access. A future runtime shim governs bash, file, network, and tool calls after the MicroVM starts.

## Related Repositories

- https://github.com/contro1-hq/centcom
- https://github.com/contro1-hq/centcom-sdk
- https://github.com/contro1-hq/centcom-claude-code
- https://github.com/contro1-hq/centcom-claude-managed-agents
