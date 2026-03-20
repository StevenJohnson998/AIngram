const { getPool } = require('../config/database');

/**
 * Apply ADHP policy filtering to subscription matches.
 * Compares chunk.adhp against each matched account's adhp profile.
 *
 * Rules (only applied when chunk.adhp IS NOT NULL):
 * - If account.adhp IS NULL → blocked (undeclared = assume worst)
 * - sensitivity_level: chunk <= account (if chunk declares one)
 * - direct_marketing_opt_out: if true on chunk, skip accounts with purpose='marketing'
 * - training_opt_out: if true on chunk, skip accounts with training_use=true
 * - scientific_research_opt_out: if true on chunk, skip accounts with purpose='scientific'
 * - jurisdiction: if chunk declares jurisdictions, account must declare one that's in the list
 *
 * @param {object} chunkAdhp - chunk's ADHP profile (may be null)
 * @param {Array} matches - array of {subscriptionId, accountId, matchType, similarity?}
 * @returns {Array} filtered matches
 */
async function filterByAdhp(chunkAdhp, matches) {
  if (!chunkAdhp || matches.length === 0) return matches;

  const pool = getPool();
  const accountIds = [...new Set(matches.map(m => m.accountId))];

  const { rows: accounts } = await pool.query(
    'SELECT id, adhp FROM accounts WHERE id = ANY($1)',
    [accountIds]
  );

  const accountMap = new Map(accounts.map(a => [a.id, a.adhp]));

  return matches.filter(match => {
    const accountAdhp = accountMap.get(match.accountId);

    // Account has no ADHP profile → blocked by any chunk that has restrictions
    if (!accountAdhp) return false;

    // sensitivity_level: chunk must be <= account's accepted level
    if (chunkAdhp.sensitivity_level != null) {
      const accountLevel = accountAdhp.sensitivity_level;
      if (accountLevel == null) return false; // undeclared = assume worst
      if (chunkAdhp.sensitivity_level > accountLevel) return false;
    }

    // direct_marketing_opt_out: chunk opts out → skip marketing agents
    if (chunkAdhp.direct_marketing_opt_out === true) {
      if (accountAdhp.purpose === 'marketing') return false;
    }

    // training_opt_out: chunk opts out → skip agents that use data for training
    if (chunkAdhp.training_opt_out === true) {
      if (accountAdhp.training_use === true) return false;
    }

    // scientific_research_opt_out: chunk opts out → skip scientific agents
    if (chunkAdhp.scientific_research_opt_out === true) {
      if (accountAdhp.purpose === 'scientific') return false;
    }

    // jurisdiction: chunk restricts to specific jurisdictions → account must be in list
    if (Array.isArray(chunkAdhp.jurisdiction) && chunkAdhp.jurisdiction.length > 0) {
      const accountJurisdiction = accountAdhp.jurisdiction;
      if (!accountJurisdiction) return false; // undeclared = blocked
      // Account jurisdiction can be a string or array
      const accountJurisdictions = Array.isArray(accountJurisdiction) ? accountJurisdiction : [accountJurisdiction];
      const hasOverlap = accountJurisdictions.some(j => chunkAdhp.jurisdiction.includes(j));
      if (!hasOverlap) return false;
    }

    return true;
  });
}

/**
 * Find subscriptions that match a newly embedded chunk.
 * Checks three subscription types: vector, keyword, topic.
 * Then applies ADHP policy filtering if the chunk has an ADHP profile.
 *
 * @param {string} chunkId - UUID of the newly embedded chunk
 * @param {'active'|'proposed'} triggerStatus - chunk status that triggered the match
 * @returns {Array<{subscriptionId, accountId, matchType: 'vector'|'keyword'|'topic', similarity?}>}
 */
async function matchNewChunk(chunkId, triggerStatus = 'active') {
  const pool = getPool();

  // 1. Get chunk data: embedding, content, adhp, and associated topic IDs
  const { rows: chunkRows } = await pool.query(
    'SELECT id, content, embedding, adhp FROM chunks WHERE id = $1',
    [chunkId]
  );

  if (chunkRows.length === 0) {
    console.warn(`matchNewChunk: chunk ${chunkId} not found`);
    return [];
  }

  const chunk = chunkRows[0];

  // Get topic IDs for this chunk
  const { rows: topicRows } = await pool.query(
    'SELECT topic_id FROM chunk_topics WHERE chunk_id = $1',
    [chunkId]
  );
  const topicIds = topicRows.map((r) => r.topic_id);

  // Determine which trigger_status values to match
  const triggerFilter = triggerStatus === 'proposed'
    ? ['proposed', 'both']
    : ['active', 'both'];

  const matches = [];

  // 2. Vector subscriptions: cosine similarity >= threshold
  if (chunk.embedding) {
    const { rows: vectorSubs } = await pool.query(
      `SELECT s.id as subscription_id, s.account_id, s.similarity_threshold,
              1 - (s.embedding <=> c.embedding) as similarity
       FROM subscriptions s, chunks c
       WHERE c.id = $1
         AND s.type = 'vector'
         AND s.active = true
         AND s.embedding IS NOT NULL
         AND s.trigger_status = ANY($2)
         AND 1 - (s.embedding <=> c.embedding) >= COALESCE(s.similarity_threshold, 0.7)`,
      [chunkId, triggerFilter]
    );

    for (const sub of vectorSubs) {
      matches.push({
        subscriptionId: sub.subscription_id,
        accountId: sub.account_id,
        matchType: 'vector',
        similarity: parseFloat(sub.similarity),
      });
    }
  }

  // 3. Keyword subscriptions: ILIKE on chunk content
  const { rows: keywordSubs } = await pool.query(
    `SELECT id as subscription_id, account_id, keyword
     FROM subscriptions
     WHERE type = 'keyword'
       AND active = true
       AND keyword IS NOT NULL
       AND trigger_status = ANY($1)`,
    [triggerFilter]
  );

  for (const sub of keywordSubs) {
    if (chunk.content.toLowerCase().includes(sub.keyword.toLowerCase())) {
      matches.push({
        subscriptionId: sub.subscription_id,
        accountId: sub.account_id,
        matchType: 'keyword',
      });
    }
  }

  // 4. Topic subscriptions: chunk's topic_id matches subscription topic_id
  if (topicIds.length > 0) {
    const { rows: topicSubs } = await pool.query(
      `SELECT id as subscription_id, account_id, topic_id
       FROM subscriptions
       WHERE type = 'topic'
         AND active = true
         AND topic_id = ANY($1)
         AND trigger_status = ANY($2)`,
      [topicIds, triggerFilter]
    );

    for (const sub of topicSubs) {
      matches.push({
        subscriptionId: sub.subscription_id,
        accountId: sub.account_id,
        matchType: 'topic',
      });
    }
  }

  // 5. ADHP policy filtering
  const filtered = await filterByAdhp(chunk.adhp, matches);

  return filtered;
}

module.exports = { matchNewChunk, filterByAdhp };
