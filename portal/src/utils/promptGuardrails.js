// Coordinates with the SYSTEM_PROMPT "File storage" guidance (useClaudeAPI.js): the
// prompt tells the model that apps storing sensitive files MUST require login and need
// IT security review before go-live. The third rule below is the matching client-side
// gate — a build request naming passenger PII / financial / medical data is flagged for
// IT Security review. Keep the two in sync: the prompt sets the expectation, this
// validator enforces it at submit time.
const RULES = [
  {
    keywords: [
      'hack', 'exploit', 'vulnerability', 'bypass security', 'unauthorized access',
      'steal data', 'surveillance without consent', 'track employees secretly',
      'spy on', 'discriminate', 'racial profiling', 'deny service based on',
    ],
    message:
      'This request contains content that may be harmful or unethical. The Citizen Developer platform is designed for building operational tools that improve airport efficiency and safety. Please revise your prompt.',
  },
  {
    keywords: [
      'personal website', 'dating app', 'social media', 'e-commerce store', 'online shop',
      'cryptocurrency', 'trading bot', 'gambling', 'game unrelated to operations',
      'my personal', 'for my side project',
    ],
    message:
      'This request appears to be outside the scope of airport operations. The Citizen Developer platform is for building tools related to terminal operations, ground handling, passenger services, logistics, security, and facility management. Please refine your prompt to align with airport operational needs.',
  },
  {
    keywords: [
      'passenger personal data', 'credit card', 'passport number', 'social security',
      'medical records without authorization', 'export all passenger', 'bulk download personal',
    ],
    message:
      'This request involves sensitive personal data that requires special handling. Building apps that process passenger PII, financial data, or medical records requires IT security review. Please contact the IT Security team before proceeding, or revise your prompt to use anonymized or aggregated data.',
  },
]

export function validatePrompt(promptText) {
  const lower = promptText.toLowerCase()
  for (const rule of RULES) {
    const flagged = rule.keywords.filter((kw) => lower.includes(kw.toLowerCase()))
    if (flagged.length > 0) {
      return { message: rule.message, flaggedKeywords: flagged }
    }
  }
  return null
}
