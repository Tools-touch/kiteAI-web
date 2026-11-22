# Kite Service Console

A runnable x402 service and six-page developer console. The paid endpoint returns a JSON report backed by a Solidity ServiceRegistry read. The default preview deploys the registry to a local Anvil chain and runs a simulated payment lifecycle with the same x402 v2 Express middleware used in official modes.

## Local preview

Requirements are Node.js 22+, npm, and [Foundry's Anvil](https://getfoundry.sh/anvil/overview/) on your PATH.

```sh
npm ci
npm run dev
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). Startup compiles and deploys the contract to a disposable Anvil process on `127.0.0.1:8547` and sets the report service to enabled at version 1. Set `PORT` or `ANVIL_PORT` if either port is taken. Stopping the console also stops its Anvil process.

| Page | URL | What to do |
| --- | --- | --- |
| Overview | `/` | See the active environment and open the report service |
| Service catalog | `/services` | See the service registration, price and availability |
| Service detail | `/services/status-report` | Inspect the GET request, request an x402 quote, execute or hand off payment, and verify the result |
| Passport | `/passport` | Identify the configured integration and check official facilitator support in official modes |
| Requests & receipts | `/requests` | Inspect recent quotes, failures and completed reports stored by this browser |
| Service registry | `/registry` | Read the service ID, contract address, chain, block and configuration |

Choose **Request payment terms** and **Simulate payment**. The page shows HTTP 402 terms, a simulated receipt, the HTTP 200 JSON report and its locally recomputed SHA-256. The registry and report identify an actual contract read on the local chain. The payment uses a short-lived HMAC authorization and a synthetic `demo-…` receipt. Run history is browser-local and limited to 20 entries.

To reproduce from a terminal with `curl` and `jq`:

```sh
curl -i http://127.0.0.1:4173/api/report
demo_signature=$(curl -fsS -X POST http://127.0.0.1:4173/api/demo/authorize | jq -r .paymentSignature)
curl -i -H "PAYMENT-SIGNATURE: $demo_signature" http://127.0.0.1:4173/api/report
curl -i -H "PAYMENT-SIGNATURE: $demo_signature" http://127.0.0.1:4173/api/report
```

Expect HTTP 402, HTTP 200 with `PAYMENT-RESPONSE`, then HTTP 402 for replay. The POST only issues a reusable-until-spent, expiring local authorization.

## Official payment modes

| `PAYMENT_MODE` | Payment network | Asset | Payer |
| --- | --- | --- | --- |
| `local` (default) | Simulated `eip155:31337` | 0.01 demoUSD | Browser demo |
| `passport` | Base mainnet `eip155:8453` | 0.01 USDC | Approved Kite Agent Passport agent session compatible with Base x402 v2 exact |
| `kite-testnet` | KiteAI Testnet `eip155:2368` | 0.01 pieUSD | Injected EVM browser wallet or an external x402 v2 exact client with an EIP-3009 payer |

The two official profiles use `https://facilitator.pieverse.io/v2` through the x402 SDK. The SDK negotiates `PAYMENT-REQUIRED`, calls `/verify` on a validly shaped payment, and calls `/settle` after a successful report. Only then does it send the report with `PAYMENT-RESPONSE`. The quote carries integer atomic amounts, the recipient, network, scheme and asset. An unavailable registry, disabled service or failed report prevents settlement for that request.

To configure an official merchant, set `PAY_TO` to the recipient EVM address and `PUBLIC_ORIGIN` to the service's public HTTPS origin. Choose the payment mode explicitly. The `.env.example` file lists the variables. To load a local `.env` file, run `node --env-file=.env server/main.js`. The server still binds to loopback by default. For an existing registry, configure both `REGISTRY_RPC_URL` and `REGISTRY_ADDRESS`; otherwise the service starts local Anvil. The registry chain and payment network are independent.

### Kite Testnet browser wallet

With `PAYMENT_MODE=kite-testnet`, open the service detail over HTTPS (localhost also works for development). Choose **Browser wallet**, then **Connect wallet**. Use an injected EIP-1193 EVM wallet with an account that supports `eth_signTypedData_v4` and holds testnet pieUSD. Switch to KiteAI Testnet (chain 2368) in the wallet, or use **Switch to KiteAI Testnet** if the wallet already knows the network. See the [official network configuration](https://docs.gokite.ai/kite-chain/1-getting-started/network-information).

Choose **Request payment terms** and check the network, token, recipient, amount and expiry. **Confirm & sign** opens a wallet prompt for one EIP-3009 `TransferWithAuthorization`. Connection, switching networks and requesting the quote each run without a payment signature. The browser submits the signed authorization once, and the facilitator relays the transfer. A wallet account or chain change before submission invalidates the quote. Rejected signatures can be retried while the quote remains valid. After a submitted payment with an uncertain result, use **Check for receipt** before authorizing another transfer. The console stores the request ID for receipt recovery after a reload.

The **External x402 client** option also remains available in this profile. The **Passport** page describes the independent Base USDC agent flow. **Local simulation** requires no wallet.

### Kite Testnet wallet quote protocol

A wallet client requests `GET /api/report` with `X-Console-Wallet` (payer address) and `X-Console-Run` (32 random bytes in lowercase hex). The 402 includes the standard `PAYMENT-REQUIRED` header and `X-Console-Quote` with the EIP-3009 nonce and its Unix expiration in seconds, separated by a colon. The signed authorization uses that nonce and the same expiration as `validBefore`. Send the resulting v2 `PAYMENT-SIGNATURE` with both request headers. The service checks the quote's wallet, ID, resource, configuration version and payment terms before facilitator verification. Each quote allows one attempt and expires after 60 seconds. Quotes and receipts are kept in server memory, so quote, submission and receipt lookup use the same running instance. Standard external x402 clients can continue to use the endpoint without the wallet headers.

### Passport buyer flow

A live check requires a reachable HTTPS origin, a configured merchant address, an authenticated Passport agent and an active spending session whose policy allows this merchant, network and amount. A real payment on the Base profile uses USDC on mainnet.

1. Open the service detail and request a quote. Review its network, asset and recipient.
2. Copy the generated `kpass session execute` command and run it from the official agent environment. It uses the currently selected session. For a CLI that exposes `agent:session` instead, replace `session` in the command with `agent:session`, after confirming that the CLI and backend support the quoted v2 scheme. The repository also provides `npm run passport:request -- https://merchant.example/api/report` for a direct call that returns its result in the CLI. Add `--legacy-cli` for the older namespace.
3. If you ran the console-generated command with `X-Console-Run`, choose **Check for receipt**. Only successfully settled reports can be retrieved with this randomly generated lookup key. The server keeps them in memory for 15 minutes, up to 1,024 entries. A concurrent or repeated payment carrying the same completed lookup key is rejected before verification. The page checks the report digest and links the transaction hash to the network explorer. On the explorer, confirm the transaction succeeded and inspect the token, amount and recipient of the transfer.

The Passport page checks facilitator capabilities without spending. Actual session, payer and settlement status are available through Passport and the receipt. The server never needs Passport credentials. The report hash checks the JSON payload's integrity, while the official facilitator receipt is the link to on-chain payment evidence.

As of **2026-11-22**, the [current Passport provider guide](https://docs.gokite.ai/passport/seller) lists Base and shows a v1 example. The [official Kite x402 Express example](https://github.com/gokite-ai/kite-x402-services/tree/893a27509648b660bbba626b0da59619a94f04ab/templates/typescript-express) implements v2 and lists Kite testnet. The live [facilitator capability endpoint](https://facilitator.pieverse.io/v2/supported) advertises v2 exact for Base and Kite testnet. The [Passport payment guide](https://docs.gokite.ai/passport/payments) documents `kpass session execute`, while the [CLI reference](https://docs.gokite.ai/reference/kpass-cli) also documents `agent:session execute`. Confirm your Passport environment supports the quoted v2 mode before authorizing spend. The Kite testnet profile demonstrates the official merchant contract and does not imply current Passport sandbox support. End-to-end Passport payment and public deployment remain unverified.

## ServiceRegistry

`configure(bytes32 id, string name, string path, bool enabled)` belongs to the immutable deployer. Every successful configuration increments that service ID's version and emits `ServiceConfigured`. Version zero means unregistered. Registering another ID preserves existing records. Disabling retains the service metadata for inspection.

The report service ID is `keccak256("kite.service.status-report")`. The backend reads the version, name, enabled flag and HTTP path at a specific block. It checks availability before payment verification and reads again before releasing a report for settlement. When adding a service, register its ID and add an explicit HTTP route and pricing configuration. The contract holds no assets, and the HTTP merchant independently specifies payment conditions and the facilitator.

## Verification and design

```sh
npm test
```

The suite also exercises the browser SDK with an injected-wallet fixture. It checks connection and network switching, validates the signed EIP-712 domain and authorization, verifies account changes and expiry during signing, and exercises a single settled result with replay rejection. The suite covers real local contract deployment, independent IDs, owner-only mutation, input validation, versioning, route guards, missing or invalid payment, concurrent replay, backend and RPC failures, registry changes, settlement failures and the verified receipt and digest. Official-mode failure and success tests run against a local HTTP facilitator fixture and use no funds.

The [selected GPT Image mockup](docs/console-design.png) informed the overview and request detail. The remaining pages use the same grid, typography, status indicators and color palette.

<details>
<summary>ImageGen prompt</summary>

Create a finished high-fidelity desktop web application UI screenshot, 1536 × 1024 landscape, for a fictional developer tool named “Kite Service Console”. Original technology aesthetic: very dark ink navy, crisp electric mint, small cyan accents, subtle dark blueprint grid, thin blue-gray outlines, technical editor style. Flat orthographic screenshot, no hardware mockup, no photo, no shadows or glow that harm readability. Top slim header with geometric kite mark, Kite Service Console, right small outlined Local simulation chip. Main centered width 1260. Top compact hero with uppercase mint 'DEVELOPER CONSOLE', large off-white 'Service Console', and 'Request a service report through x402.' Add simple subtle thin-line orbital geometry toward the hero's right, no words in the artwork. Below: two equal-height panels in a 58/42 split. Left panel 'Service status report', green Enabled chip, GET pill and /api/report in a terminal inset, details price 0.01 USDT, local chain, config version v1, one large mint button 'Request payment terms'. Right panel 'Request & payment', vertical four step timeline 'Request', 'Payment terms', 'Payment verification', 'Verified result', current first step mint. Below the panels one full-width bordered 'Service registry' band with 3 detail columns including Network, Contract, Config version, and a discreet copy address icon. restrained technical editorial typography, bold tight Bricolage Grotesque headlines, concise readable mono endpoint labels. generous alignment, thoughtful spacing, functional, approachable. Keep all text clear and sparse. Show just this one UI screen.

</details>
