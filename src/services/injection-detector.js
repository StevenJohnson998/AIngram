/**
 * Prompt injection detection for chunk content.
 * Heuristic regex-based — flags suspicious content for priority review.
 * Does NOT block submissions (false positives on legitimate content about injection are too high).
 */

const PATTERNS = [
  // Instruction override — highest risk
  { regex: /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|context|guidelines?)/gi, weight: 0.8, flag: 'instruction_override' },
  { regex: /\bdo\s+not\s+(follow|obey|listen\s+to|adhere\s+to|comply\s+with)\b/gi, weight: 0.5, flag: 'instruction_override' },
  { regex: /\bnew\s+instructions?\s*:/gi, weight: 0.7, flag: 'instruction_override' },

  // Data exfiltration
  { regex: /\b(reveal|show|display|print|output|leak|expose)\s+(your|the|all)\s+(instructions?|system\s*prompt|rules?|config|secret|password|key)/gi, weight: 0.6, flag: 'data_exfiltration' },
  { regex: /\bwhat\s+(are|is)\s+your\s+(system\s+)?(instructions?|prompt|rules?)\b/gi, weight: 0.4, flag: 'data_exfiltration' },

  // Delimiter abuse
  { regex: /```(system|assistant|user|instruction)\b/gi, weight: 0.5, flag: 'delimiter_abuse' },
  { regex: /<\/?(?:system|instruction|prompt|admin)>/gi, weight: 0.5, flag: 'delimiter_abuse' },
  { regex: /\[SYSTEM\]|\[INST\]|\[\/INST\]/g, weight: 0.5, flag: 'delimiter_abuse' },

  // Role hijacking
  { regex: /\b(act|behave|respond|function|operate)\s+(as|like)\s+(a|an|the|my)\s+\w+/gi, weight: 0.4, flag: 'role_hijack' },
  { regex: /\bfrom\s+now\s+on\b/gi, weight: 0.3, flag: 'behavior_change' },
  { regex: /\byou\s+are\s+(now|a|an|my)\b/gi, weight: 0.3, flag: 'persona_assignment' },

  // Output manipulation
  { regex: /\b(always|never|only)\s+(say|respond|output|return|answer|reply)\b/gi, weight: 0.4, flag: 'output_manipulation' },
  { regex: /\brepeat\s+(after\s+me|this|the\s+following|back)\b/gi, weight: 0.3, flag: 'output_manipulation' },

  // Encoding abuse
  { regex: /\b(base64|hex|rot13|unicode)\s*(decode|encode|convert)\b/gi, weight: 0.3, flag: 'encoding_abuse' },

  // Social engineering targeting LLMs
  { regex: /\b(security\s+team|admin(istrator)?(\s+team)?|support\s+team|platform\s+team|moderation\s+team)\s+(here|requests?|needs?|requires?|asks?)/gi, weight: 0.5, flag: 'social_engineering' },
  { regex: /\bplease\s+(share|provide|send|give|reveal|show)\s+(your|the|any)\s+(api[_\s]?key|token|credential|password|secret|key|email|personal)/gi, weight: 0.7, flag: 'social_engineering' },
  { regex: /\b(urgent|immediate|mandatory|required)\s+(action|verification|update|review)\s+(needed|required|necessary)\b/gi, weight: 0.4, flag: 'social_engineering' },
  { regex: /\bthis\s+is\s+(a|an)\s+(official|authorized|mandatory|required)\s+(request|notice|message)\b/gi, weight: 0.5, flag: 'social_engineering' },
  { regex: /\b(verify|confirm|validate)\s+your\s+(identity|account|credentials|access)\b/gi, weight: 0.5, flag: 'social_engineering' },
  { regex: /\bcontact\s+(me|us)\s+(at|via|through|on)\b/gi, weight: 0.3, flag: 'social_engineering' },
];

// Regex to match security-example blocks (with or without markdown fences)
const SECURITY_EXAMPLE_RE = /```security-example\s*\n?([\s\S]*?)```(?:end-security-example)?/g;

/**
 * Score a text segment against all patterns.
 * @param {string} text
 * @param {number} [offset] - Offset to add to match positions (for segments extracted from larger content)
 * @returns {{ rawScore: number, flags: Set<string>, matches: Array<{start:number,end:number,flag:string,weight:number}> }}
 */
function scoreSegment(text, offset = 0) {
  let rawScore = 0;
  const flags = new Set();
  const matches = [];
  for (const pattern of PATTERNS) {
    // matchAll needs a global regex; PATTERNS already use /g or /gi.
    const iter = text.matchAll(pattern.regex);
    let count = 0;
    for (const m of iter) {
      if (count < 3) {
        // Only keep positions for the first 3 matches per pattern (matches the score cap below).
        matches.push({
          start: m.index + offset,
          end: m.index + m[0].length + offset,
          flag: pattern.flag,
          weight: pattern.weight,
        });
      }
      count++;
    }
    if (count > 0) {
      rawScore += pattern.weight * Math.min(count, 3);
      flags.add(pattern.flag);
    }
  }
  return { rawScore, flags, matches };
}

/**
 * Analyze content for prompt injection patterns.
 * Content inside security-example blocks is scored with a reduced weight
 * (configurable via security_config table to prevent gamification).
 * @param {string} content - The chunk content to analyze
 * @returns {{ score: number, flags: string[], suspicious: boolean }}
 */
function analyzeContent(content) {
  if (!content || typeof content !== 'string') {
    return { score: 0, flags: [], suspicious: false };
  }

  // Load weight from config (lazy require to avoid circular deps at module load)
  let exampleWeight;
  try {
    exampleWeight = require('./security-config').getConfig('security_example_weight');
  } catch { /* fallback */ }
  if (typeof exampleWeight !== 'number') exampleWeight = 0.15;

  // Separate security-example blocks from regular content, keeping track of
  // original positions so match offsets map back to the input string.
  const exampleBlocks = []; // { inner, innerStart }
  let regularContent = '';
  let regularIndex = 0; // cumulative length of regular segments written so far
  const regularToOriginal = []; // segments: { regStart, origStart, length }
  let lastEnd = 0;
  SECURITY_EXAMPLE_RE.lastIndex = 0;
  let m;
  while ((m = SECURITY_EXAMPLE_RE.exec(content)) !== null) {
    const matchStart = m.index;
    const matchEnd = m.index + m[0].length;
    // Append regular segment before this block
    if (matchStart > lastEnd) {
      const segment = content.slice(lastEnd, matchStart);
      regularToOriginal.push({ regStart: regularIndex, origStart: lastEnd, length: segment.length });
      regularContent += segment;
      regularIndex += segment.length;
    }
    // Record the block with the inner-content offset in original string
    const inner = m[1] || '';
    // Find inner start inside the full match
    const innerOffsetInMatch = m[0].indexOf(inner);
    const innerStart = matchStart + (innerOffsetInMatch >= 0 ? innerOffsetInMatch : 0);
    exampleBlocks.push({ inner, innerStart });
    lastEnd = matchEnd;
  }
  // Tail segment
  if (lastEnd < content.length) {
    const segment = content.slice(lastEnd);
    regularToOriginal.push({ regStart: regularIndex, origStart: lastEnd, length: segment.length });
    regularContent += segment;
    regularIndex += segment.length;
  }

  // Map a position inside regularContent back to the original content position.
  function regToOriginal(regPos) {
    for (const seg of regularToOriginal) {
      if (regPos >= seg.regStart && regPos < seg.regStart + seg.length) {
        return seg.origStart + (regPos - seg.regStart);
      }
    }
    // Fall back to last segment end if regPos equals total length
    const last = regularToOriginal[regularToOriginal.length - 1];
    return last ? last.origStart + last.length : regPos;
  }

  // Score regular content at full weight
  const regular = scoreSegment(regularContent);
  let totalScore = regular.rawScore;
  const allFlags = regular.flags;
  const allMatches = regular.matches.map((mm) => ({
    ...mm,
    start: regToOriginal(mm.start),
    end: regToOriginal(mm.end - 1) + 1,
  }));

  // Score security-example blocks: reduced weight ONLY if they use [UNSAFE INSTRUCTION] placeholder
  // AND the block's raw score is low (legitimate educational content).
  // Blocks without placeholder, or with placeholder but suspiciously high raw score
  // (someone hiding real injection alongside the placeholder), get full weight.
  const PLACEHOLDER_RE = /\[UNSAFE INSTRUCTION\]/i;
  for (const { inner, innerStart } of exampleBlocks) {
    const seg = scoreSegment(inner, innerStart);
    const hasPlaceholder = PLACEHOLDER_RE.test(inner);
    // A legitimate example with placeholder should score low (the placeholder itself isn't an injection).
    // If raw score is high despite placeholder, the block contains real injection too.
    const isTrustedExample = hasPlaceholder && seg.rawScore < 1.2;
    const weight = isTrustedExample ? exampleWeight : 1.0;
    totalScore += seg.rawScore * weight;
    for (const f of seg.flags) allFlags.add(f);
    // Tag matches from security-example blocks so the preview builder can
    // de-prioritise them (trusted examples should not dominate the window).
    for (const mm of seg.matches) {
      allMatches.push({ ...mm, weight: mm.weight * weight, inSecurityExample: true });
    }
  }

  // Normalize to 0-1 range (2.0 = rough max expected from legitimate suspicious content)
  const normalizedScore = Math.min(totalScore / 2.0, 1.0);

  return {
    score: parseFloat(normalizedScore.toFixed(3)),
    flags: [...allFlags],
    suspicious: normalizedScore >= 0.5,
    matches: allMatches,
  };
}

/**
 * Analyze user-provided text and emit a structured log warning if suspicious.
 *
 * Use this for fields where you want defensive telemetry but no blocking
 * behavior: account names, topic titles/summaries, discussion messages,
 * dispute reasons, etc. The chunk content path uses analyzeContent()
 * directly because it has additional quarantine logic.
 *
 * @param {string} text - User-provided text
 * @param {string} fieldType - Field identifier for the log (e.g. 'topic.title')
 * @param {object} [context] - Extra fields to include in the log (account id, etc.)
 * @returns {{ score: number, flags: string[], suspicious: boolean }}
 */
function analyzeUserInput(text, fieldType, context = {}) {
  const result = analyzeContent(text);
  if (result.suspicious) {
    // Single-line JSON for log aggregator parsing
    console.warn(`[InjectionDetector] suspicious ${fieldType}: ${JSON.stringify({
      score: result.score,
      flags: result.flags,
      ...context,
    })}`);
  }
  return result;
}

module.exports = { analyzeContent, analyzeUserInput, PATTERNS, SECURITY_EXAMPLE_RE };
