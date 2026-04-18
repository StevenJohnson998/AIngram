#!/usr/bin/env node
/**
 * Auto-crosslink: discovers related topics and proposes edits that add
 * [[slug]] internal links to each chunk. Does NOT add sources (manual pass).
 *
 * Usage:
 *   API_URL=https://ailore.ai API_KEY=aingram_xxx node scripts/auto-crosslink.js
 *
 * Options:
 *   --dry-run     Print what would be edited without proposing
 *   --lang=en     Filter topics by language (default: en)
 *   --limit=100   Max topics to process (default: all)
 *   --delay=500   Delay between edits in ms (default: 500)
 */

const API_URL = process.env.API_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error('API_KEY is required.');
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LANG = (args.find(a => a.startsWith('--lang=')) || '--lang=en').split('=')[1];
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '--limit=999').split('=')[1], 10);
const DELAY = parseInt((args.find(a => a.startsWith('--delay=')) || '--delay=500').split('=')[1], 10);
const MAX_LINKS_PER_CHUNK = 2;
const MIN_SIMILARITY = parseFloat((args.find(a => a.startsWith('--min-sim=')) || '--min-sim=0.75').split('=')[1]);

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${API_KEY}`,
};

async function get(path) {
  const res = await fetch(`${API_URL}${path}`, { headers });
  if (!res.ok) return null;
  const json = await res.json();
  return json.data || json;
}

async function post(path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    console.error(`  ERROR ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
    return null;
  }
  return json.data || json;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function chunkAlreadyLinks(content) {
  return /\[\[.+?\]\]/.test(content);
}

function buildLinkSentence(related) {
  if (related.length === 1) {
    return `See also [[${related[0].slug}|${related[0].title}]].`;
  }
  const links = related.map(r => `[[${r.slug}|${r.title}]]`);
  return `See also ${links.slice(0, -1).join(', ')} and ${links[links.length - 1]}.`;
}

async function getAllTopics() {
  let allTopics = [];
  let page = 1;
  const perPage = 50;
  while (true) {
    const res = await fetch(`${API_URL}/v1/topics?lang=${LANG}&limit=${perPage}&page=${page}`, { headers });
    const json = await res.json();
    const topics = json.data || [];
    if (topics.length === 0) break;
    allTopics = allTopics.concat(topics);
    if (!json.pagination || allTopics.length >= json.pagination.total) break;
    page++;
  }
  return allTopics;
}

async function main() {
  console.log(`Auto-crosslink ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log(`API: ${API_URL} | lang: ${LANG} | limit: ${LIMIT}`);
  console.log('─'.repeat(60));

  const topics = await getAllTopics();
  console.log(`Found ${topics.length} topics (lang=${LANG})`);

  const toProcess = topics.slice(0, LIMIT);
  let editCount = 0;
  let skipCount = 0;

  for (const topic of toProcess) {
    console.log(`\n▸ ${topic.title} (${topic.slug})`);

    // Get full topic with chunks
    const full = await get(`/v1/topics/${topic.id}`);
    if (!full || !full.chunks || full.chunks.length === 0) {
      console.log('  No chunks, skipping');
      continue;
    }

    // Discover related topics
    const relRes = await fetch(`${API_URL}/v1/topics/${topic.id}/related`, { headers });
    let related = [];
    if (relRes.ok) {
      const relJson = await relRes.json();
      related = (relJson.data || [])
        .map(r => ({ slug: r.topicSlug, title: r.topicTitle, similarity: r.score }))
        .filter(r => r.similarity >= MIN_SIMILARITY && r.slug !== topic.slug)
        .slice(0, MAX_LINKS_PER_CHUNK + 1);
    }

    if (related.length === 0) {
      console.log('  No sufficiently related topics found');
      skipCount += full.chunks.length;
      continue;
    }

    console.log(`  Related: ${related.map(r => r.slug + ' (' + (r.similarity * 100).toFixed(0) + '%)').join(', ')}`);

    // For each chunk, propose edit adding links
    for (let i = 0; i < full.chunks.length; i++) {
      const chunk = full.chunks[i];

      if (chunkAlreadyLinks(chunk.content)) {
        console.log(`  Chunk ${i + 1}/${full.chunks.length}: already has links, skipping`);
        skipCount++;
        continue;
      }

      // Pick different related topics for different chunks to vary the links
      const linksForChunk = related.slice(i % related.length, i % related.length + MAX_LINKS_PER_CHUNK);
      if (linksForChunk.length === 0) {
        linksForChunk.push(related[0]);
      }

      const linkSentence = buildLinkSentence(linksForChunk);
      const newContent = chunk.content.trimEnd() + ' ' + linkSentence;

      if (newContent.length > 5000) {
        console.log(`  Chunk ${i + 1}/${full.chunks.length}: would exceed 5000 chars, skipping`);
        skipCount++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  Chunk ${i + 1}/${full.chunks.length}: WOULD add: ${linkSentence}`);
        editCount++;
      } else {
        const result = await post(`/v1/chunks/${chunk.id}/propose-edit`, { content: newContent });
        if (result) {
          console.log(`  Chunk ${i + 1}/${full.chunks.length}: ✓ proposed (${linkSentence.slice(0, 80)}...)`);
          editCount++;
        } else {
          console.log(`  Chunk ${i + 1}/${full.chunks.length}: ✗ failed`);
        }
        await sleep(DELAY);
      }
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`Done: ${editCount} edits ${DRY_RUN ? 'would be ' : ''}proposed, ${skipCount} skipped`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
