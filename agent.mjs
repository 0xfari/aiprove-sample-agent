// aiprove-sample-agent — sample agent for the AIProve arena.
// Reads aiprove.fun/skill.md, authenticates with its own keypair,
// lists open bounties, and enters one. Full loop, no human in the loop.
//
// Usage:
//   API_BASE_URL=https://aiprove.fun   (default; set to a staging host to run there)
//   AGENT_PRIVATE_KEY=0x...            (optional; otherwise a keypair is
//                                        generated and saved to ./agent-key.json)
//   BOUNTY_SLUG=<slug>                 (optional; otherwise enters the first
//                                        open bounty from the list)
//   node agent.mjs
//
// The agent NEVER prints its private key or its session token. The transcript
// it writes (transcript.md) contains only addresses, slugs and HTTP statuses.
import { Wallet } from "ethers";
import fs from "fs";

const API = (process.env.API_BASE_URL || "https://aiprove.fun").replace(/\/$/, "");
const KEY_PATH = "./agent-key.json";
const log = (...a) => console.log(new Date().toISOString(), ...a);

function loadOrCreateKeypair() {
  if (process.env.AGENT_PRIVATE_KEY) {
    const w = new Wallet(process.env.AGENT_PRIVATE_KEY);
    log("[keypair] loaded from AGENT_PRIVATE_KEY, address", w.address);
    return w;
  }
  if (fs.existsSync(KEY_PATH)) {
    const { privateKey } = JSON.parse(fs.readFileSync(KEY_PATH, "utf8"));
    const w = new Wallet(privateKey);
    log("[keypair] loaded from", KEY_PATH + ", address", w.address);
    return w;
  }
  const w = Wallet.createRandom();
  fs.writeFileSync(KEY_PATH, JSON.stringify({ address: w.address, privateKey: w.privateKey }, null, 2), { mode: 0o600 });
  log("[keypair] generated fresh keypair, address", w.address, "(saved 0600 to", KEY_PATH + ")");
  return w;
}

async function main() {
  log("[step 1] reading skill.md from", API + "/skill.md");
  const skill = await (await fetch(`${API}/skill.md`)).text();
  const endpoints = [...skill.matchAll(/\| (GET|POST) \| `([^`]+)`/g)].map((m) => `${m[1]} ${m[2]}`);
  log(`[step 1] skill.md read (${skill.length} chars), ${endpoints.length} endpoints documented`);
  if (!skill.includes("/api/auth/challenge") || !skill.includes("/api/auth/verify")) {
    throw new Error("skill.md does not document the auth flow - aborting");
  }

  const wallet = loadOrCreateKeypair();

  log("[step 2] requesting auth challenge for", wallet.address);
  const ch = await (await fetch(`${API}/api/auth/challenge?address=${wallet.address}`)).json();
  if (!ch.challenge) throw new Error("no challenge returned: " + JSON.stringify(ch).slice(0, 200));
  const signature = await wallet.signMessage(ch.challenge);
  log("[step 2] challenge signed (EIP-191 personal_sign)");

  log("[step 3] exchanging signature for a session token");
  const v = await (await fetch(`${API}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: wallet.address, signature }),
  })).json();
  if (!v.token) throw new Error("auth failed: " + JSON.stringify(v).slice(0, 200));
  log("[step 3] authenticated as", v.address, "- session token received (not printed)");
  const auth = { Authorization: "Bearer " + v.token };

  log("[step 4] listing open bounties");
  const list = await (await fetch(`${API}/api/bounties?status=open`)).json();
  const bounties = Array.isArray(list) ? list : list.bounties || [];
  log(`[step 4] ${bounties.length} open bounties`);
  for (const b of bounties.slice(0, 8)) log(`  - ${b.slug} [${b.cat}/${b.lane}] ${b.amt} ${b.unit} closes ${b.closes}`);

  const slug = process.env.BOUNTY_SLUG || bounties[0]?.slug;
  if (!slug) throw new Error("no open bounty to enter");
  log("[step 5] entering bounty", slug);
  const r = await fetch(`${API}/api/bounties/${slug}/enter`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ handle: wallet.address.slice(0, 10) }),
  });
  const entered = await r.json();
  log("[step 5] enter HTTP", r.status, JSON.stringify(entered).slice(0, 200));
  if (r.status !== 200 && r.status !== 201) throw new Error("enter failed");

  log("[done] full loop completed cleanly: skill.md -> auth -> list -> enter", slug);
}

main().catch((e) => { console.error("[fatal]", e.message); process.exit(1); });
