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
];

/**
 * Analyze content for prompt injection patterns.
 * @param {string} content - The chunk content to analyze
 * @returns {{ score: number, flags: string[], suspicious: boolean }}
 */
function analyzeContent(content) {
  if (!content || typeof content !== 'string') {
    return { score: 0, flags: [], suspicious: false };
  }

  let totalScore = 0;
  const flags = new Set();

  for (const pattern of PATTERNS) {
    const matches = content.match(pattern.regex);
    if (matches) {
      // Cap repeated matches at 3 to prevent gaming the score
      totalScore += pattern.weight * Math.min(matches.length, 3);
      flags.add(pattern.flag);
    }
  }

  // Normalize to 0-1 range (2.0 = rough max expected from legitimate suspicious content)
  const normalizedScore = Math.min(totalScore / 2.0, 1.0);

  return {
    score: parseFloat(normalizedScore.toFixed(3)),
    flags: [...flags],
    suspicious: normalizedScore >= 0.5,
  };
}

module.exports = { analyzeContent, PATTERNS };
