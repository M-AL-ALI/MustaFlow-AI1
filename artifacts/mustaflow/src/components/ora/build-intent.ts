const BUILD_INTENT_PATTERNS = [
  /\bbuild\b/i,
  /\bcreate\b/i,
  /\bmake\b/i,
  /\bgenerate\b/i,
  /\bturn this into\b/i,
  /\bstart (?:a |the )?project\b/i,
  /\bstart (?:a |the )?new (?:app|site|tool)\b/i,
  /\bopen in builder\b/i,
  /\bwant to build\b/i,
  /\bplan(?:ning)? (?:to build|an? app|an? project|a site)\b/i,
  /\bbuild it\b/i,
  /\bcan (?:you|mustaflow) build\b/i,
  /\bi want (?:a |an |to )\b(?:app|website|site|tool|dashboard|mvp|prototype)\b/i,
  /\bi (?:need|want) to build\b/i,
  /\bmy app idea\b/i,
  /\bmy (?:project|app|startup) idea\b/i,
  /\blaunch (?:a |an |my )\b(?:app|site|product|startup)\b/i,
  /\bprototype\b.{0,40}\bfor me\b/i,
];

const SUPPRESS_PATTERNS = [
  /^(?:what|how|why|when|where|who|which|is|are|does|do)\b/i,
  /^(?:tell me|explain|describe|summarize|translate|analyze|review|compare|list|show me)\b/i,
  /\bexplain\b/i,
  /\btranslat/i,
  /\bsummariz/i,
  /\banalyze\b/i,
  /\banalysis\b/i,
  /\breview\b/i,
  /\bcheck (?:this|my|if)\b/i,
  /\bdebug\b/i,
  /\bfix (?:this|my|the)\b/i,
  /\btroubleshoot/i,
  /\bhelp me understand\b/i,
  /\bwhat (?:does|is|are)\b/i,
  /\bhow (?:does|do|can|to)\b/i,
  /\badvice\b/i,
  /\btips?\b/i,
  /\brecommend/i,
  /\bpros and cons\b/i,
  /\bcompar/i,
];

export function hasBuildIntent(userMessage: string, _assistantReply: string): boolean {
  const userTrimmed = userMessage.trim();

  // Explicit build patterns always win — check before suppression
  for (const pattern of BUILD_INTENT_PATTERNS) {
    if (pattern.test(userTrimmed)) return true;
  }

  // Only suppress if no build pattern matched
  for (const pattern of SUPPRESS_PATTERNS) {
    if (pattern.test(userTrimmed)) return false;
  }

  return false;
}
