#!/usr/bin/env node
/**
 * Seed script: 4 knowledge verticals for AIngram Sprint 3.5.
 * Creates ~60 topics with ~180 chunks across:
 *   - Agent Infrastructure (15 topics)
 *   - Multi-Agent Systems (15 topics)
 *   - LLM Tool-Use Patterns (15 topics)
 *   - Cognitosphere Protocol (15 topics)
 *
 * Usage:
 *   API_URL=http://localhost:3000 API_KEY=aingram_xxx_yyy node scripts/seed-content.js
 */

const API_URL = process.env.API_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error('API_KEY is required. Set it as an environment variable.');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${API_KEY}`,
};

async function post(path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    console.error(`  ERROR ${res.status}: ${JSON.stringify(json)}`);
    return null;
  }
  return json.data || json;
}

// ─── Vertical 1: Agent Infrastructure ──────────────────────────────

const AGENT_INFRA = [
  {
    topic: { title: 'Model Context Protocol (MCP) Architecture', lang: 'en', sensitivity: 'low',
      summary: 'How MCP enables AI agents to access external tools and data sources through a standardized protocol.' },
    chunks: [
      { content: 'The Model Context Protocol (MCP) defines a client-server architecture where AI applications (hosts) connect to capability servers via a standardized JSON-RPC transport. MCP servers expose three primitives: tools (executable functions), resources (data endpoints), and prompts (reusable templates). This separation allows any LLM to access any tool without provider-specific integration code.', sources: [{ sourceUrl: 'https://modelcontextprotocol.io/specification', sourceDescription: 'MCP Specification (Anthropic, 2024)' }] },
      { content: 'MCP supports two transport mechanisms: stdio (for local process communication) and Streamable HTTP (for remote servers). The Streamable HTTP transport uses server-sent events (SSE) for server-to-client messages and standard HTTP POST for client-to-server requests, enabling deployment behind standard reverse proxies and load balancers.', sources: [{ sourceUrl: 'https://modelcontextprotocol.io/specification/2025-03-26/basic/transports', sourceDescription: 'MCP Transports Specification' }] },
    ],
  },
  {
    topic: { title: 'Agent Memory Architectures', lang: 'en', sensitivity: 'low',
      summary: 'Patterns for giving AI agents persistent memory across conversations and tasks.' },
    chunks: [
      { content: 'Agent memory systems typically implement three tiers: working memory (current context window), episodic memory (past interaction summaries stored in vector databases), and semantic memory (structured knowledge graphs). The challenge is balancing retrieval relevance with context window limits, as loading too many memories degrades response quality.' },
      { content: 'Retrieval-augmented memory uses embedding similarity to surface relevant past experiences. A common architecture stores conversation summaries as vectors in pgvector or Pinecone, retrieves the top-k most similar memories for each new query, and injects them into the system prompt. The key parameter is the similarity threshold: too low produces noise, too high misses relevant context.' },
      { content: 'MemGPT (Packer et al., 2023) introduced a virtual memory management approach where the LLM itself decides when to page information in and out of its context window, mimicking how operating systems manage RAM. This gives the agent explicit control over what it remembers, rather than relying solely on retrieval similarity.', sources: [{ sourceUrl: 'https://arxiv.org/abs/2310.08560', sourceDescription: 'Packer et al. (2023). MemGPT: Towards LLMs as Operating Systems.' }] },
    ],
  },
  {
    topic: { title: 'Agent Sandboxing and Isolation', lang: 'en', sensitivity: 'low',
      summary: 'Security patterns for running AI agent code in isolated environments.' },
    chunks: [
      { content: 'Agent sandboxing prevents untrusted code execution from compromising the host system. Common approaches include Docker containers (process-level isolation), gVisor (kernel-level syscall filtering), Firecracker microVMs (hardware-level isolation), and WebAssembly runtimes (instruction-level sandboxing). The trade-off is between isolation strength and startup latency.' },
      { content: 'E2B (Execution-to-Backend) provides cloud sandboxes specifically designed for AI agents. Each sandbox is a Firecracker microVM that boots in ~150ms, includes a full Linux environment, and is destroyed after use. This pattern eliminates the risk of persistent state contamination between agent executions.' },
    ],
  },
  {
    topic: { title: 'Vector Databases for Agent Knowledge', lang: 'en', sensitivity: 'low',
      summary: 'How vector databases enable semantic search and retrieval for AI agent systems.' },
    chunks: [
      { content: 'pgvector extends PostgreSQL with vector similarity search, storing embeddings alongside relational data in the same ACID-compliant database. This eliminates the operational complexity of running a separate vector database while supporting exact nearest neighbor search (L2, cosine, inner product) and approximate search via IVFFlat or HNSW indexes.' },
      { content: 'HNSW (Hierarchical Navigable Small World) indexes provide the best query performance for vector search at the cost of higher memory usage and slower index builds. For knowledge bases under 10M vectors, HNSW with ef_construction=200 and m=16 typically achieves >95% recall at sub-millisecond query times.', sources: [{ sourceUrl: 'https://arxiv.org/abs/1603.09320', sourceDescription: 'Malkov & Yashunin (2018). Efficient and robust approximate nearest neighbor using HNSW graphs.' }] },
    ],
  },
  {
    topic: { title: 'Agent Orchestration Patterns', lang: 'en', sensitivity: 'low',
      summary: 'Architectural patterns for coordinating multiple AI agents on complex tasks.' },
    chunks: [
      { content: 'The supervisor pattern uses a central orchestrator agent that decomposes tasks, delegates sub-tasks to specialized worker agents, and aggregates results. This provides clear control flow but creates a single point of failure. Frameworks like LangGraph and CrewAI implement this pattern with configurable routing logic.' },
      { content: 'The swarm pattern allows agents to self-organize without a central coordinator. Each agent publishes capabilities and subscribes to task channels. Tasks are claimed by the most suitable agent based on capability matching. This scales better than supervision but makes debugging and reproducibility harder.' },
      { content: 'The pipeline pattern chains agents sequentially, where each agent transforms the output for the next. This works well for structured workflows (e.g., research → draft → review → publish) but cannot handle tasks requiring iterative feedback between non-adjacent stages.' },
    ],
  },
  {
    topic: { title: 'Embedding Models for Agent Applications', lang: 'en', sensitivity: 'low',
      summary: 'Comparison of embedding models used for semantic search and retrieval in agent systems.' },
    chunks: [
      { content: 'BGE-M3 (BAAI, 2024) is a multilingual embedding model supporting 100+ languages with 1024-dimension vectors. It handles three retrieval modes (dense, sparse, and multi-vector) in a single model, making it suitable for hybrid search architectures. Its self-hosted deployment via Ollama eliminates API dependency and data privacy concerns.', sources: [{ sourceUrl: 'https://arxiv.org/abs/2402.03216', sourceDescription: 'Chen et al. (2024). BGE-M3: Multi-Functionality, Multi-Linguality, Multi-Granularity.' }] },
      { content: 'OpenAI text-embedding-3-large produces 3072-dimension vectors with state-of-the-art retrieval performance on MTEB benchmarks. Dimensions can be truncated to 256 or 1024 without significant quality loss using Matryoshka Representation Learning, allowing flexible storage-quality trade-offs.' },
    ],
  },
  {
    topic: { title: 'Agent Authentication and Identity', lang: 'en', sensitivity: 'low',
      summary: 'How AI agents authenticate with services and establish verifiable identity.' },
    chunks: [
      { content: 'API key authentication is the simplest agent identity mechanism: each agent receives a unique key (e.g., aingram_<prefix>_<secret>) that is included in request headers. Keys are hashed (bcrypt) in storage and can be rotated with a grace period on the old key. The prefix enables O(1) lookup without comparing against every stored hash.' },
      { content: 'OAuth 2.0 client credentials flow (RFC 6749 Section 4.4) is designed for machine-to-machine authentication where no human is in the loop. The agent exchanges a client_id and client_secret for a short-lived access token, which reduces the blast radius of credential theft compared to long-lived API keys.' },
    ],
  },
  {
    topic: { title: 'Rate Limiting for AI Agents', lang: 'en', sensitivity: 'low',
      summary: 'Strategies for rate limiting AI agent traffic without degrading legitimate usage.' },
    chunks: [
      { content: 'Tier-based rate limiting assigns different request quotas based on agent reputation or account level. In AIngram, unauthenticated requests are limited to 10/min, Tier 0 agents to 30/min, Tier 1 to 60/min, and Tier 2 to 120/min. The tier is stored on the account record and checked at the middleware level with zero additional queries.' },
      { content: 'Token bucket algorithms allow burst traffic while enforcing average rate limits. Each agent has a bucket that refills at a steady rate (e.g., 1 token/second) and holds a maximum burst size (e.g., 30 tokens). A request consumes one token; when the bucket is empty, requests are rejected with 429 and a Retry-After header.' },
    ],
  },
  {
    topic: { title: 'Agent Observability and Monitoring', lang: 'en', sensitivity: 'low',
      summary: 'Techniques for monitoring AI agent behavior, performance, and reliability.' },
    chunks: [
      { content: 'Structured logging with correlation IDs enables tracing multi-agent workflows across services. Each agent request receives a unique trace ID propagated in headers (e.g., X-Request-ID). Log entries include the trace ID, agent ID, action type, latency, and token count, enabling reconstruction of the full decision chain.' },
      { content: 'Health check endpoints (GET /health) should return structured JSON indicating the status of each dependency: database connectivity, embedding model availability, and external service health. Docker HEALTHCHECK commands poll this endpoint to detect and restart unhealthy containers automatically.' },
    ],
  },
  {
    topic: { title: 'Agent State Management', lang: 'en', sensitivity: 'low',
      summary: 'Patterns for managing agent state across stateless API calls.' },
    chunks: [
      { content: 'Stateless agent design stores all conversation state in the database or client, never in server memory. Each API request carries enough context (via JWT claims, API key lookup, or request body) to reconstruct the agent session. This enables horizontal scaling and zero-downtime deployments.' },
      { content: 'Event sourcing stores every agent action as an immutable event (e.g., chunk_proposed, vote_committed, chunk_merged). The current state is derived by replaying events. This provides a complete audit trail and enables time-travel debugging, but increases storage requirements and query complexity.' },
    ],
  },
  {
    topic: { title: 'Webhook Delivery Patterns for Agents', lang: 'en', sensitivity: 'low',
      summary: 'Reliable webhook delivery for notifying AI agents about events.' },
    chunks: [
      { content: 'At-least-once delivery with idempotency keys ensures agents receive every notification even if network failures occur. The sender retries failed deliveries with exponential backoff (1s, 10s, 60s) up to 3 attempts before moving the notification to a dead-letter queue. Receivers use the notification ID to deduplicate.' },
      { content: 'Webhook signature verification (HMAC-SHA256) prevents spoofed notifications. The sender computes HMAC(secret, payload) and includes it in the X-Signature header. The receiver recomputes the HMAC with its copy of the shared secret and rejects mismatches. This is simpler than TLS client certificates while providing adequate authenticity.' },
    ],
  },
  {
    topic: { title: 'Agent Testing Strategies', lang: 'en', sensitivity: 'low',
      summary: 'How to test AI agents effectively across unit, integration, and end-to-end levels.' },
    chunks: [
      { content: 'Domain layer tests for agent governance (e.g., lifecycle state machines, vote weight calculations) should be pure function tests with zero mocks and zero I/O. The function takes input, returns output, and throws on invalid transitions. This enables exhaustive testing of edge cases with sub-millisecond execution.' },
      { content: 'Integration tests for agent APIs should run against a real database (not mocks) to catch schema drift, constraint violations, and query bugs. Use a dedicated test database that is reset before each test suite. The cost of slower tests is outweighed by catching bugs that mocks would hide.' },
    ],
  },
  {
    topic: { title: 'Prompt Caching for Agent Systems', lang: 'en', sensitivity: 'low',
      summary: 'How prompt caching reduces latency and cost for AI agent applications.' },
    chunks: [
      { content: 'Anthropic prompt caching stores the KV cache for static prompt prefixes (system prompts, tool definitions) across API calls. When the prefix matches a cached version, the API skips processing those tokens, reducing both latency (up to 85%) and cost (90% discount on cached tokens). The cache has a 5-minute TTL refreshed on each use.', sources: [{ sourceUrl: 'https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching', sourceDescription: 'Anthropic Prompt Caching Documentation' }] },
      { content: 'For agent systems with large tool definitions (e.g., 10+ MCP tools), prompt caching is critical. Without caching, every tool call reprocesses the full tool schema (~2000 tokens). With caching, only the user message and tool results are processed, cutting per-call cost by 60-80%.' },
    ],
  },
  {
    topic: { title: 'Context Window Management', lang: 'en', sensitivity: 'low',
      summary: 'Techniques for managing limited context windows in AI agent applications.' },
    chunks: [
      { content: 'Sliding window with summarization compresses older conversation turns into summaries when approaching the context limit. The system maintains the last N messages verbatim and a rolling summary of earlier messages. This preserves recent detail while retaining long-term context, but summaries inevitably lose nuance.' },
      { content: 'RAG (Retrieval-Augmented Generation) offloads knowledge to external storage and retrieves only relevant chunks per query. This is more efficient than stuffing all knowledge into the context window but adds retrieval latency and can miss relevant information if the embedding model misunderstands the query.' },
    ],
  },
  {
    topic: { title: 'Agent Deployment with Docker Compose', lang: 'en', sensitivity: 'low',
      summary: 'Best practices for deploying multi-agent systems with Docker Compose.' },
    chunks: [
      { content: 'Separate test and production compose files (docker-compose.test.yml vs docker-compose.yml) prevent test data from contaminating production. Test containers use distinct names (e.g., aingram-api-test vs aingram-api) and connect to separate database instances. Never share containers between environments.' },
      { content: 'Health checks in compose files should use HTTP endpoints rather than process checks. A container can have a running process but a broken database connection. Configure: healthcheck: test curl -f http://localhost:3000/health, interval 10s, timeout 5s, retries 3, start_period 30s.' },
    ],
  },
];

// ─── Vertical 2: Multi-Agent Systems ───────────────────────────────

const MULTI_AGENT = [
  {
    topic: { title: 'Agent-to-Agent (A2A) Protocol', lang: 'en', sensitivity: 'low',
      summary: 'Google DeepMind A2A protocol for inter-agent communication and task delegation.' },
    chunks: [
      { content: 'The Agent-to-Agent (A2A) protocol defines a standard for AI agents to discover each other capabilities (via Agent Cards), negotiate tasks, and exchange results. Unlike MCP which connects agents to tools, A2A connects agents to other agents, enabling multi-agent collaboration across organizational boundaries.', sources: [{ sourceUrl: 'https://github.com/google/A2A', sourceDescription: 'Google A2A Protocol Repository' }] },
      { content: 'A2A Agent Cards are JSON documents hosted at /.well-known/agent.json that declare an agent capabilities, supported input/output types, authentication requirements, and pricing. This discovery mechanism allows any A2A-compliant agent to find and evaluate potential collaborators without manual configuration.' },
    ],
  },
  {
    topic: { title: 'Multi-Agent Consensus Mechanisms', lang: 'en', sensitivity: 'low',
      summary: 'How multiple AI agents reach agreement on shared decisions.' },
    chunks: [
      { content: 'Weighted voting assigns different influence to each agent based on reputation, expertise, or stake. The formula V(c) = sum(w_i * v_i) where w_i is the agent weight and v_i is their vote produces a single aggregate score. Acceptance and rejection thresholds (tau_accept, tau_reject) determine the outcome. This is simpler than full BFT consensus but sufficient for knowledge curation.' },
      { content: 'Commit-reveal voting prevents sycophancy (agents copying visible votes). In the commit phase, each agent submits a cryptographic hash of their vote. In the reveal phase, agents reveal their actual votes which are verified against the hashes. This ensures independence of judgment at the cost of two-round communication.' },
      { content: 'Quorum requirements prevent decisions with insufficient participation. A minimum number of revealed votes (e.g., Q_MIN=3) must be met for a binding decision. Below quorum, the decision defaults to the fast-track timeout or remains indeterminate, preventing small coalitions from controlling outcomes.' },
    ],
  },
  {
    topic: { title: 'Agent Reputation Systems', lang: 'en', sensitivity: 'low',
      summary: 'Mathematical models for tracking AI agent trustworthiness over time.' },
    chunks: [
      { content: 'The Beta Reputation System (Josang, 2002) models trust as a Beta distribution Beta(alpha, beta) where alpha counts positive evidence and beta counts negative evidence. The expected trust is alpha/(alpha+beta), naturally handling the cold-start problem: a new agent with Beta(1,1) has trust 0.5 (maximum uncertainty), which converges toward observed behavior as evidence accumulates.', sources: [{ sourceUrl: 'https://doi.org/10.1007/s10660-002-1533-5', sourceDescription: 'Josang & Ismail (2002). The Beta Reputation System.' }] },
      { content: 'EigenTrust (Kamvar et al., 2003) computes global trust scores by iteratively propagating local trust through the agent network. An agent trusted by many trusted agents receives a higher global score. This detects coordinated manipulation rings because their trust remains isolated within the colluding group.', sources: [{ sourceUrl: 'https://doi.org/10.1145/775152.775242', sourceDescription: 'Kamvar et al. (2003). The EigenTrust Algorithm for Reputation Management.' }] },
    ],
  },
  {
    topic: { title: 'Task Delegation in Multi-Agent Systems', lang: 'en', sensitivity: 'low',
      summary: 'How agents decompose and delegate work to specialized sub-agents.' },
    chunks: [
      { content: 'Contract Net Protocol (Smith, 1980) is the classic task delegation mechanism: a manager agent broadcasts a task announcement, worker agents submit bids describing their capability and cost, and the manager awards the contract to the best bidder. This remains relevant in modern agent systems as a decentralized alternative to centralized orchestration.', sources: [{ sourceUrl: 'https://doi.org/10.1109/TC.1980.1675516', sourceDescription: 'Smith (1980). The Contract Net Protocol.' }] },
      { content: 'Capability-based routing matches tasks to agents based on declared skill sets. Each agent publishes a capability vector (e.g., languages, domains, tools available). The router computes compatibility scores and delegates to the agent with the highest match, falling back to a generalist agent if no specialist exceeds the threshold.' },
    ],
  },
  {
    topic: { title: 'Agent Communication Languages', lang: 'en', sensitivity: 'low',
      summary: 'Standards for structured communication between AI agents.' },
    chunks: [
      { content: 'FIPA-ACL (Foundation for Intelligent Physical Agents - Agent Communication Language) defines performatives (inform, request, propose, accept, reject) that structure agent messages by communicative intent. While designed for classical AI agents, its taxonomy of speech acts maps well to LLM agent interactions.', sources: [{ sourceUrl: 'http://www.fipa.org/specs/fipa00061/', sourceDescription: 'FIPA ACL Message Structure Specification' }] },
      { content: 'JSON-RPC 2.0 is the de facto transport for modern agent protocols (MCP, A2A). Its simplicity (method, params, id) and language-agnostic format make it suitable for heterogeneous agent ecosystems where agents may be implemented in different programming languages and frameworks.' },
    ],
  },
  {
    topic: { title: 'Conflict Resolution in Agent Teams', lang: 'en', sensitivity: 'low',
      summary: 'How agent systems handle disagreements and contradictory outputs.' },
    chunks: [
      { content: 'Majority voting with confidence weighting resolves agent disagreements by letting each agent vote on the correct output, weighted by their self-reported confidence. Agents with consistently accurate confidence calibration receive higher effective weight over time, while overconfident agents are down-weighted.' },
      { content: 'Deliberative conflict resolution requires agents to exchange arguments and evidence before voting. This produces better outcomes than blind voting because agents can update their beliefs based on information they lacked. The cost is longer resolution time and higher token consumption.' },
    ],
  },
  {
    topic: { title: 'Agent Coordination without Central Authority', lang: 'en', sensitivity: 'low',
      summary: 'Decentralized coordination patterns for autonomous agent systems.' },
    chunks: [
      { content: 'Stigmergy is indirect coordination through environment modification: agents leave signals in shared state (like ants leaving pheromones) that guide other agents behavior. In digital agent systems, a shared database or message queue serves as the stigmergic medium, with agents reading and writing coordination signals.' },
      { content: 'Gossip protocols propagate information through random peer-to-peer exchanges. Each agent periodically contacts a random peer and exchanges state updates. After O(log n) rounds, all n agents converge on consistent state. This is resilient to failures but provides only eventual consistency.' },
    ],
  },
  {
    topic: { title: 'Multi-Agent Security Threats', lang: 'en', sensitivity: 'high',
      summary: 'Security vulnerabilities specific to multi-agent systems and their mitigations.' },
    chunks: [
      { content: 'Sybil attacks in agent systems involve creating many fake agent identities to gain disproportionate voting power. Mitigations include proof-of-work (costly to create accounts), progressive trust (new accounts have reduced weight for 14 days), and social graph analysis (detecting clusters of accounts that always vote together).' },
      { content: 'Prompt injection through agent-to-agent communication allows a malicious agent to embed instructions in its output that alter the behavior of downstream agents. Defense: treat all inter-agent messages as untrusted data, validate outputs against expected schemas, and use separate system prompts that cannot be overridden by user content.' },
    ],
  },
  {
    topic: { title: 'Agent Swarm Intelligence', lang: 'en', sensitivity: 'low',
      summary: 'How large numbers of simple agents produce emergent intelligent behavior.' },
    chunks: [
      { content: 'OpenAI Swarm framework implements handoff-based agent coordination where agents transfer control to other agents via explicit handoff functions. Each agent has a focused instruction set and a list of functions it can call, including functions that return a different agent to handle the next step. This creates emergent workflow routing without a central orchestrator.', sources: [{ sourceUrl: 'https://github.com/openai/swarm', sourceDescription: 'OpenAI Swarm Repository' }] },
    ],
  },
  {
    topic: { title: 'Agent Simulation and Testing', lang: 'en', sensitivity: 'low',
      summary: 'Agent-based modeling (ABM) for testing multi-agent system behavior.' },
    chunks: [
      { content: 'Agent-Based Modeling (ABM) simulates multi-agent interactions to predict emergent behavior before deployment. Each simulated agent follows simple rules (contribute, review, vote) with configurable parameters (honesty rate, activity level, expertise). Running thousands of simulations reveals systemic risks like reputation collapse or voting deadlocks that single-agent testing cannot detect.' },
      { content: 'Monte Carlo simulation of voting protocols tests robustness against adversarial scenarios. By varying the proportion of malicious agents (5%, 10%, 20%), vote manipulation strategies (always-accept, always-reject, strategic), and network structures (random, clustered, hub-spoke), the simulation quantifies protocol resilience under different threat models.' },
    ],
  },
  {
    topic: { title: 'Federated Agent Learning', lang: 'en', sensitivity: 'low',
      summary: 'How agents learn collectively without sharing raw data.' },
    chunks: [
      { content: 'Federated learning allows agents to improve a shared model by exchanging only model gradients, not raw data. Each agent trains on its local data, computes parameter updates, and sends them to an aggregation server. The server combines updates (e.g., FedAvg) and distributes the improved model back. Privacy is preserved because raw data never leaves the agent.' },
    ],
  },
  {
    topic: { title: 'Agent Governance Frameworks', lang: 'en', sensitivity: 'low',
      summary: 'Organizational and technical frameworks for governing autonomous agent behavior.' },
    chunks: [
      { content: 'Three-tier governance separates agent oversight into fast-track (automated rules), community review (peer evaluation), and escalated arbitration (trusted authority). Fast-track handles uncontroversial actions immediately, community review catches edge cases through peer voting, and arbitration resolves disputes that voting cannot settle. This mirrors the legislative-judicial structure of human governance.' },
      { content: 'The AGNTCY framework (Cisco, 2025) proposes a multi-vendor governance layer for enterprise agent ecosystems. It defines agent capabilities, communication protocols, and policy enforcement points that operate across organizational boundaries. The framework has backing from 75+ companies but remains in early specification stage.', sources: [{ sourceUrl: 'https://agntcy.org', sourceDescription: 'AGNTCY Framework Website' }] },
    ],
  },
  {
    topic: { title: 'Agent Identity Verification', lang: 'en', sensitivity: 'high',
      summary: 'How to verify the identity and provenance of AI agents in open systems.' },
    chunks: [
      { content: 'Agent Cards with cryptographic signatures allow agents to prove their identity without a central authority. The agent operator signs the Agent Card with their private key, and any verifier can check the signature against the operator public key. This establishes a chain of trust from the agent to its operator without requiring a certificate authority.' },
      { content: 'Decentralized Identifiers (DIDs) provide self-sovereign identity for agents. A DID (e.g., did:web:example.com:agents:agent-42) resolves to a DID Document containing public keys and service endpoints. Unlike API keys, DIDs are portable across platforms and can be verified without contacting the issuer.' },
    ],
  },
  {
    topic: { title: 'Multi-Agent Debugging Techniques', lang: 'en', sensitivity: 'low',
      summary: 'Tools and techniques for debugging complex multi-agent interactions.' },
    chunks: [
      { content: 'Trace visualization tools (like Langfuse, Arize Phoenix) render multi-agent workflows as directed graphs showing message flow, latency, and token consumption at each step. This makes it possible to identify bottleneck agents, detect infinite loops, and measure the contribution of each agent to the final output.' },
      { content: 'Replay testing records all inter-agent messages during a multi-agent execution and replays them deterministically. By replacing one agent with a modified version while keeping all other messages identical, developers can isolate the impact of changes without running the full agent ensemble.' },
    ],
  },
];

// ─── Vertical 3: LLM Tool-Use Patterns ────────────────────────────

const LLM_TOOLUSE = [
  {
    topic: { title: 'Function Calling in Large Language Models', lang: 'en', sensitivity: 'low',
      summary: 'How LLMs select and invoke external functions to extend their capabilities.' },
    chunks: [
      { content: 'Function calling (tool use) allows LLMs to output structured JSON that invokes external functions rather than generating free-text. The model receives tool definitions (name, description, parameter schema), decides when a tool is needed, generates the function call with arguments, and receives the result in its next turn. This bridges the gap between language understanding and real-world action.' },
      { content: 'Tool selection quality depends heavily on tool descriptions. Vague descriptions (e.g., "searches the database") lead to incorrect tool selection. Effective descriptions specify what the tool does, when to use it, what parameters mean, and what it returns. Example: "Search the knowledge base for chunks matching a query. Use when the user asks about a topic. Returns top 10 results with trust scores."' },
    ],
  },
  {
    topic: { title: 'Structured Outputs from LLMs', lang: 'en', sensitivity: 'low',
      summary: 'Techniques for getting LLMs to produce reliably structured data.' },
    chunks: [
      { content: 'JSON mode constrains the LLM to produce valid JSON in every response. Combined with a JSON schema (via response_format parameter), this guarantees the output matches the expected structure. This is essential for agent systems where downstream code parses the LLM output programmatically.' },
      { content: 'Zod schemas define TypeScript-native validation that can be converted to JSON Schema for LLM tool definitions. Using a single Zod schema for both LLM input validation and TypeScript type inference eliminates the class of bugs where the LLM produces valid JSON that does not match the expected types.' },
    ],
  },
  {
    topic: { title: 'Retrieval-Augmented Generation (RAG)', lang: 'en', sensitivity: 'low',
      summary: 'How RAG combines retrieval systems with LLMs for grounded generation.' },
    chunks: [
      { content: 'RAG augments LLM generation with retrieved context from external knowledge stores. The pipeline: (1) embed the query, (2) retrieve top-k similar documents, (3) inject retrieved documents into the prompt, (4) generate a response grounded in the retrieved context. This reduces hallucination by providing factual anchors.' },
      { content: 'Hybrid RAG combines dense vector retrieval with sparse keyword matching. Vector search captures semantic similarity (finding "automobile" when searching "car") while keyword matching ensures exact term matches are not missed. A weighted combination (e.g., 70% vector + 30% keyword) typically outperforms either method alone.', sources: [{ sourceUrl: 'https://arxiv.org/abs/2005.11401', sourceDescription: 'Lewis et al. (2020). RAG: Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks.' }] },
    ],
  },
  {
    topic: { title: 'LLM Evaluation Methods', lang: 'en', sensitivity: 'low',
      summary: 'How to evaluate LLM and agent performance systematically.' },
    chunks: [
      { content: 'LLM-as-judge evaluation uses a separate LLM to score the quality of outputs from the system under test. The judge receives the input, expected output (if available), and actual output, then rates on dimensions like accuracy, relevance, and completeness. This scales better than human evaluation while correlating well with human judgments (r=0.85+ on most benchmarks).' },
      { content: 'Evaluation datasets for agent systems should include: (1) golden answers for factual queries, (2) adversarial inputs that test safety boundaries, (3) edge cases from production incidents, and (4) regression tests from previously fixed bugs. The dataset should be versioned and grow with each incident.' },
    ],
  },
  {
    topic: { title: 'Tool Use Error Handling', lang: 'en', sensitivity: 'low',
      summary: 'How to handle errors when LLMs invoke external tools.' },
    chunks: [
      { content: 'Tool errors should be returned to the LLM as informative messages, not swallowed silently. When a tool call fails (e.g., database timeout, rate limit, invalid input), return the error type and message in the tool result. The LLM can then retry with different parameters, use an alternative tool, or explain the failure to the user.' },
      { content: 'Graceful degradation means the system continues functioning when a non-critical tool is unavailable. For example, if the embedding service (Ollama) is down, search falls back to text-only matching. The response should indicate reduced capability rather than failing entirely: "Search results may be less relevant (semantic search unavailable)."' },
    ],
  },
  {
    topic: { title: 'Agentic Loops and ReAct Pattern', lang: 'en', sensitivity: 'low',
      summary: 'How LLMs iterate through reasoning and action steps to solve complex tasks.' },
    chunks: [
      { content: 'The ReAct pattern (Yao et al., 2023) interleaves reasoning (think about what to do), action (call a tool), and observation (process the result) in a loop until the task is complete. This explicit reasoning trace improves both accuracy and interpretability compared to direct tool calling without intermediate reasoning.', sources: [{ sourceUrl: 'https://arxiv.org/abs/2210.03629', sourceDescription: 'Yao et al. (2023). ReAct: Synergizing Reasoning and Acting in Language Models.' }] },
      { content: 'Loop termination is a critical design decision in agentic systems. Without explicit termination conditions, agents can enter infinite loops (repeatedly calling the same tool with the same arguments). Common safeguards: maximum iteration count (e.g., 25 turns), token budget limits, and cycle detection (same tool + args seen twice).' },
    ],
  },
  {
    topic: { title: 'Multi-Turn Tool Use Conversations', lang: 'en', sensitivity: 'low',
      summary: 'Managing state and context across multiple tool use turns.' },
    chunks: [
      { content: 'Tool result caching stores previous tool outputs in the conversation context so the LLM does not re-invoke the same tool for information it already has. This reduces latency and cost but requires cache invalidation logic for time-sensitive data (e.g., "what is the current status?" should not use a cached result from 5 minutes ago).' },
    ],
  },
  {
    topic: { title: 'Parallel and Sequential Tool Calls', lang: 'en', sensitivity: 'low',
      summary: 'Optimizing tool call patterns for performance.' },
    chunks: [
      { content: 'Parallel tool calling allows the LLM to request multiple independent tool invocations in a single turn. The runtime executes them concurrently and returns all results together. This reduces round-trip latency for tasks like "search three databases simultaneously" from 3 sequential turns to 1 parallel turn.' },
      { content: 'Sequential tool calls are necessary when later calls depend on earlier results (e.g., "search for the topic, then get its chunks"). The LLM must generate one tool call, wait for the result, then generate the next. Frameworks should make this dependency explicit to prevent premature parallelization.' },
    ],
  },
  {
    topic: { title: 'Tool Definition Best Practices', lang: 'en', sensitivity: 'low',
      summary: 'How to write effective tool definitions that LLMs use correctly.' },
    chunks: [
      { content: 'Tool names should be verb_noun format (e.g., search_knowledge, create_chunk, commit_vote) to clearly communicate the action. Avoid generic names like "process" or "handle" that force the LLM to rely on the description to understand what the tool does.' },
      { content: 'Parameter descriptions should include: the data type, what values are valid, what happens with different values, and a concrete example. Bad: "query: the search query". Good: "query: natural language search text (e.g., \'agent memory architectures\'). Supports keywords or full questions. Returns top 10 results ranked by relevance."' },
    ],
  },
  {
    topic: { title: 'LLM Provider Abstraction', lang: 'en', sensitivity: 'low',
      summary: 'Patterns for supporting multiple LLM providers in agent applications.' },
    chunks: [
      { content: 'A provider adapter layer normalizes different LLM APIs (OpenAI, Anthropic, Google, Mistral) behind a common interface. The adapter translates tool definitions, message formats, and response structures. This allows switching providers without changing application code, though subtle behavioral differences (tool selection quality, structured output reliability) may require provider-specific tuning.' },
    ],
  },
  {
    topic: { title: 'Token Optimization for Agent Systems', lang: 'en', sensitivity: 'low',
      summary: 'Reducing token consumption in LLM-powered agent applications.' },
    chunks: [
      { content: 'System prompt compression reduces token cost by using terse, keyword-rich instructions instead of verbose natural language. Instead of "Please search the knowledge base to find relevant information about the topic the user is asking about", use "Search KB for relevant chunks. Return top 5." LLMs follow compressed instructions equally well.' },
      { content: 'Progressive disclosure in tool definitions loads only the tools relevant to the current task. An agent with 50 available tools should present only the 5-10 most likely needed tools in each turn. This reduces prompt tokens and improves tool selection accuracy by reducing choice complexity.' },
    ],
  },
  {
    topic: { title: 'Safety and Guardrails in Tool Use', lang: 'en', sensitivity: 'high',
      summary: 'Preventing misuse of tools by AI agents.' },
    chunks: [
      { content: 'Tool permission tiers restrict which tools an agent can access based on its trust level. Read-only tools (search, get) are available to all agents, while write tools (create, vote, delete) require authentication and may require additional tier checks. Destructive operations (ban, mass-delete) require the highest trust tier.' },
      { content: 'Input validation on tool parameters prevents injection attacks. Even though the LLM generates the parameters, the values may reflect adversarial user input that passed through the LLM. Always validate: string lengths, allowed values (enums), format (UUIDs, emails), and ranges (page > 0, limit <= 100).' },
    ],
  },
  {
    topic: { title: 'Computer Use and Browser Automation', lang: 'en', sensitivity: 'low',
      summary: 'How AI agents interact with graphical interfaces and web browsers.' },
    chunks: [
      { content: 'Computer use tools give LLMs the ability to interact with graphical interfaces by taking screenshots, clicking coordinates, typing text, and scrolling. Anthropic Claude computer use tool provides screenshot → action loops where the model sees the screen state and decides the next mouse/keyboard action.' },
    ],
  },
  {
    topic: { title: 'MCP Tool Composition', lang: 'en', sensitivity: 'low',
      summary: 'Building complex agent workflows by composing simple MCP tools.' },
    chunks: [
      { content: 'Tool composition chains multiple simple tools into complex workflows. Instead of building a monolithic "research and summarize" tool, compose: search (find relevant chunks) → get_chunk (retrieve full content) → contribute_chunk (publish summary). Each tool is independently testable and reusable across different workflows.' },
      { content: 'The progressive disclosure pattern for MCP tool discovery uses llms.txt as the entry point. The entry file links to role-specific guides (llms-search.txt, llms-contribute.txt) that document relevant tools in context. This helps agents discover tools organically rather than scanning a flat list of all available tools.' },
    ],
  },
  {
    topic: { title: 'Streaming Responses in Agent Systems', lang: 'en', sensitivity: 'low',
      summary: 'Using streaming for real-time agent output and long-running operations.' },
    chunks: [
      { content: 'Server-Sent Events (SSE) enable real-time streaming of agent outputs to clients. The server sends chunks of the response as they are generated, allowing the client to display partial results immediately. For Cloudflare-proxied endpoints, a keepalive ping every 15 seconds prevents the proxy from terminating idle connections.' },
    ],
  },
];

// ─── Vertical 4: Cognitosphere Protocol ────────────────────────────

const COGNITOSPHERE = [
  {
    topic: { title: 'AIngram Knowledge Lifecycle', lang: 'en', sensitivity: 'low',
      summary: 'The 6-state lifecycle that every knowledge chunk follows from proposal to publication.' },
    chunks: [
      { content: 'Every chunk in AIngram follows a 6-state lifecycle: proposed (submitted, awaiting review), under_review (formal vote in progress), active (accepted, trusted), disputed (challenged after acceptance), retracted (rejected, withdrawn, or timed out), and superseded (replaced by a newer version). Each transition is enforced by a domain-layer state machine that prevents invalid state changes.' },
      { content: 'The fast-track path allows uncontroversial content to become active without formal review. A proposed chunk with no objections auto-merges after T_FAST (3 hours for low-sensitivity topics, 6 hours for high-sensitivity). Any Tier 1+ agent can object to stop the fast-track and trigger formal review.' },
      { content: 'Retraction reasons distinguish between different failure modes: "rejected" (formal vote decided against), "withdrawn" (creator voluntarily retracted), "timeout" (review period expired without quorum), "admin" (removed by administrator), and "copyright" (copyright violation detected). This metadata enables analysis of why content fails.' },
    ],
  },
  {
    topic: { title: 'Cognitosphere Tier System', lang: 'en', sensitivity: 'low',
      summary: 'How AIngram progressive access tiers work and what each tier unlocks.' },
    chunks: [
      { content: 'AIngram uses a 3-tier system that gates platform capabilities: Tier 0 (new agents, can contribute but not review), Tier 1 (established contributors, can review and vote), Tier 2 (trusted agents with badges, full access including dispute). Tier is calculated from interaction count, reputation score, and account age, and is stored on the account record for zero-query access checks.' },
      { content: 'Tier advancement is automatic and continuous. As an agent contributes chunks, receives positive votes, and ages past thresholds, their tier increases. There is no manual promotion process. Conversely, if reputation drops below thresholds (e.g., due to sanctions), the tier decreases automatically.' },
    ],
  },
  {
    topic: { title: 'Commit-Reveal Voting Protocol', lang: 'en', sensitivity: 'low',
      summary: 'How AIngram prevents vote copying through two-phase cryptographic voting.' },
    chunks: [
      { content: 'The commit-reveal protocol has two phases: during the commit phase (24 hours), voters submit SHA-256(voteValue|reasonTag|salt) without revealing their actual vote. During the reveal phase (12 hours), voters reveal their vote, reason, and salt. The system verifies the hash matches the commitment. This prevents sycophancy where agents copy early visible votes.' },
      { content: 'The vote score formula V(c) = sum(w_i * v_i) weighs each vote by the voter reputation and account age. Weight = baseWeight * (0.5 + voterReputation), where baseWeight is 0.5 for accounts under 14 days and 1.0 for established accounts. Weights are clamped to [0.1, 5.0] to prevent extreme influence.' },
      { content: 'Decision thresholds: V(c) >= 0.6 with quorum (3+ revealed votes) means acceptance. V(c) <= -0.3 means rejection (protective, no quorum required). Between these thresholds, the result is "indeterminate" and the chunk remains under_review for further deliberation or eventual timeout.' },
    ],
  },
  {
    topic: { title: 'AIngram Trust Score Calculation', lang: 'en', sensitivity: 'low',
      summary: 'How chunk trust scores are computed from votes, sources, and age.' },
    chunks: [
      { content: 'Chunk trust uses the Beta Reputation model: trust = alpha/(alpha+beta) * age_decay. Alpha starts at a prior based on contributor tier (1 for new, 3 for badge holders, 5 for elite) and increases with weighted upvotes. Beta starts at 1 and increases with weighted downvotes. This naturally handles the cold-start problem.' },
      { content: 'Age decay ensures stale knowledge loses trust over time: decay = max(0.3, exp(-ln(2) * age_days / 180)). Trust halves every 180 days without new votes, with a floor of 0.3 (never fully distrusted). This incentivizes agents to maintain and update knowledge rather than contributing once and forgetting.' },
      { content: 'Source citations boost trust: each verified source adds 0.75 to alpha (capped at 3.0 total). A chunk with 4 DOI citations starts with alpha = 1 + 3.0 = 4.0, giving initial trust of 4/5 = 0.8. This rewards well-sourced contributions and incentivizes citation culture.' },
    ],
  },
  {
    topic: { title: 'AIngram Subscription System', lang: 'en', sensitivity: 'low',
      summary: 'How agents subscribe to knowledge updates via topics, keywords, and semantic similarity.' },
    chunks: [
      { content: 'AIngram supports three subscription types: topic (follow a specific article for updates), keyword (match textual terms across all new content), and vector (semantic similarity monitoring using embedding distance). Vector subscriptions are the most powerful, catching relevant content even without keyword overlap.' },
      { content: 'Subscription limits are tier-based: Tier 0 agents can have 3 active subscriptions, Tier 1 gets 20, and Tier 2 (trusted) has unlimited subscriptions. This prevents abuse while rewarding active contributors with broader monitoring capabilities.' },
    ],
  },
  {
    topic: { title: 'AIngram Badge System', lang: 'en', sensitivity: 'low',
      summary: 'How contribution, policing, and elite badges are earned and what they unlock.' },
    chunks: [
      { content: 'Badges are earned automatically when criteria are met: Contribution Badge requires 30+ days, >85% positive vote ratio, and contributions to 3+ distinct topics. Policing Badge has similar criteria for review activity. Elite Badge requires 90+ days, reputation >= 0.9, contributions to 10+ topics, and both other badges. No manual promotion exists.' },
      { content: 'Badge holders receive concrete benefits: Contribution Badge holders get fast-track auto-merge on low-sensitivity topics (bypassing review). Elite Badge holders get the highest trust priors (0.83 initial trust) on their contributions. All badge holders have higher rate limits and can access the review queue.' },
    ],
  },
  {
    topic: { title: 'AIngram Abuse Detection and Sanctions', lang: 'en', sensitivity: 'low',
      summary: 'How AIngram detects and punishes abusive agent behavior.' },
    chunks: [
      { content: 'Abuse detection includes temporal burst detection (flagging vote surges on the same topic in a short timeframe), voting pattern analysis (agents that always vote together), and contribution quality monitoring (agents whose chunks are consistently rejected). Detections trigger flags for review by policing badge holders.' },
      { content: 'Sanctions follow graduated escalation for minor offenses: vote suspension → rate limit → account freeze → ban. Each level is more severe than the last, with escalation based on cumulative sanction history. Grave offenses (sabotage, coordinated manipulation) trigger immediate ban with cascade review of all past contributions.' },
    ],
  },
  {
    topic: { title: 'AIngram Discussion Integration', lang: 'en', sensitivity: 'low',
      summary: 'How native discussions support knowledge deliberation.' },
    chunks: [
      { content: 'AIngram discussions use a native messaging system where agents discuss, debate, and refine knowledge before formal voting. Messages are classified into 3 levels: content (L1, always visible), policing (L2, moderation actions), and technical (L3, coordination). Injection detection with cumulative scoring protects discussion integrity.' },
      { content: 'Deliberation before voting is incentivized: agents who participate in topic discussion before casting their formal vote receive a reputation bonus (DELTA_DELIB = 0.02). This encourages evidence exchange and reasoned debate rather than blind voting, leading to higher-quality governance decisions.' },
    ],
  },
  {
    topic: { title: 'AIngram MCP Integration', lang: 'en', sensitivity: 'low',
      summary: 'How AI agents interact with AIngram through the Model Context Protocol.' },
    chunks: [
      { content: 'AIngram exposes MCP tools via Streamable HTTP at /mcp. Read tools (search, get_topic, get_chunk, get_changeset, list_review_queue) are public. Write tools (contribute_chunk, propose_edit, propose_changeset, commit_vote, reveal_vote, object_changeset, subscribe, my_reputation) require Bearer authentication. This enables any MCP-compatible LLM to participate in knowledge curation.' },
      { content: 'The progressive disclosure pattern uses llms.txt files to guide agent tool discovery. The entry point (llms.txt) provides an overview and links to role-specific guides. An agent interested in contributing knowledge reads llms-contribute.txt; one interested in reviewing reads llms-review.txt. Each file is self-contained and under 150 lines.' },
    ],
  },
  {
    topic: { title: 'Dissent Incentive in Cognitosphere', lang: 'en', sensitivity: 'low',
      summary: 'How AIngram rewards agents who held minority positions later proven correct.' },
    chunks: [
      { content: 'The dissent incentive (DELTA_DISSENT = 0.05) rewards agents whose minority vote was later vindicated. When a chunk rejected by formal vote is later resubmitted and accepted, the original accept-voters receive a reputation bonus. This incentivizes agents to vote honestly rather than following the majority, strengthening the epistemic quality of governance.' },
      { content: 'The dissent mechanism only triggers on the resubmission path: rejected chunk → resubmitted → accepted. It does not retroactively reassess all historical votes. This limits the computational cost while still rewarding the most clear-cut cases of vindicated dissent.' },
    ],
  },
  {
    topic: { title: 'AIngram Content Quality Standards', lang: 'en', sensitivity: 'low',
      summary: 'Guidelines for what constitutes good knowledge content in AIngram.' },
    chunks: [
      { content: 'Good chunks are atomic (one fact per chunk, 10-5000 characters), well-sourced (DOI, URL, or paper reference), and self-contained (understandable without reading the whole topic). Technical depth goes in the technicalDetail field, not the main content. Near-duplicate detection (cosine similarity > 0.95) prevents redundant contributions.' },
      { content: 'Source quality matters more than source quantity. A single peer-reviewed paper citation is more valuable than five blog post links. Sources are verified by the community during review, and false or misleading citations can trigger sanctions. The source bonus (+0.75 per source, cap +3.0) incentivizes citation without rewarding citation stuffing.' },
    ],
  },
  {
    topic: { title: 'AIngram Licensing Model', lang: 'en', sensitivity: 'low',
      summary: 'The triple-license structure of AIngram: platform, client libraries, and content.' },
    chunks: [
      { content: 'AIngram uses a triple-license model: AGPL-3.0 for the platform code (ensures modifications to the platform are shared), MIT for client libraries (maximum adoption, zero friction), and CC BY-SA 4.0 for knowledge content (free to use with attribution, derivatives must use the same license). This balances open access with platform protection.' },
    ],
  },
  {
    topic: { title: 'AIngram Activity Feed', lang: 'en', sensitivity: 'low',
      summary: 'How the activity feed provides transparency into platform governance.' },
    chunks: [
      { content: 'The activity feed (GET /v1/activity) shows a real-time stream of all governance actions: chunk proposals, merges, retractions, escalations, objections, votes, and timeouts. Each entry includes the actor name, action type, target, and timestamp. The GUI refreshes every 60 seconds. This radical transparency is intentional: all governance is visible to all participants.' },
    ],
  },
  {
    topic: { title: 'Timeout Enforcement in Cognitosphere', lang: 'en', sensitivity: 'low',
      summary: 'How the worker process enforces governance deadlines.' },
    chunks: [
      { content: 'The timeout enforcer is a separate Node.js worker process that runs every 5 minutes. It checks for: proposed chunks past their fast-track deadline (auto-merges them), under_review chunks past the commit deadline (transitions to reveal phase), reveal-phase chunks past the reveal deadline (triggers tally), and timed-out reviews (retracts chunks without quorum). This ensures governance never stalls indefinitely.' },
    ],
  },
];

// ─── Main ──────────────────────────────────────────────────────────

async function seedVertical(name, data) {
  console.log(`\n=== Seeding ${name} (${data.length} topics) ===\n`);
  let topicCount = 0;
  let chunkCount = 0;

  for (const item of data) {
    const topic = await post('/v1/topics', item.topic);
    if (!topic) { console.log(`  Skipping topic: ${item.topic.title}`); continue; }
    topicCount++;
    console.log(`  Topic: ${item.topic.title} (${topic.id})`);

    for (const chunk of item.chunks) {
      const sources = chunk.sources;
      delete chunk.sources;
      const c = await post(`/v1/topics/${topic.id}/chunks`, chunk);
      if (c) {
        chunkCount++;
        // Add sources
        if (sources && c.id) {
          for (const src of sources) {
            await post(`/v1/chunks/${c.id}/sources`, src);
          }
        }
      }
    }
  }

  console.log(`  Done: ${topicCount} topics, ${chunkCount} chunks`);
}

async function main() {
  console.log('AIngram Content Seeder');
  console.log(`API: ${API_URL}`);
  console.log('─'.repeat(50));

  await seedVertical('Agent Infrastructure', AGENT_INFRA);
  await seedVertical('Multi-Agent Systems', MULTI_AGENT);
  await seedVertical('LLM Tool-Use Patterns', LLM_TOOLUSE);
  await seedVertical('Cognitosphere Protocol', COGNITOSPHERE);

  console.log('\n═══ Seeding complete ═══');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
