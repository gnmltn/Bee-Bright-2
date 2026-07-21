/**
 * Program-specific recommendation links for tutors.
 * Maps program/subject names (from API) to curated resource URLs.
 */
export const PROGRAM_RECOMMENDATION_LINKS: { keywords: string[]; url: string; label: string }[] = [
  {
    keywords: ["Toddlers Playgroup", "Toddler"],
    url: "https://www.khanacademy.org/early-math",
    label: "Early Math & Readiness Resources",
  },
  {
    keywords: ["Pre-Kindergarten Readiness", "Pre-Kindergarten"],
    url: "https://www.khanacademy.org/early-math/cc-early-math-counting-topic",
    label: "Pre-K Math & Literacy",
  },
  {
    keywords: ["Kindergarten Readiness", "Kindergarten"],
    url: "https://www.khanacademy.org/early-math",
    label: "Kindergarten Readiness Resources",
  },
  {
    keywords: ["Academic Tutorial", "Academic"],
    url: "https://www.khanacademy.org",
    label: "Academic Subject Resources (Math, Science, English)",
  },
  {
    keywords: ["SPED Tutorial", "SPED"],
    url: "https://www.understood.org",
    label: "Special Education & IEP Resources",
  },
  {
    keywords: ["Examination Preparation", "Exam Prep"],
    url: "https://www.khanacademy.org/test-prep",
    label: "Test Prep & Practice",
  },
];

const FALLBACK_LINK = { url: "https://www.khanacademy.org", label: "General learning resources" };

export function getProgramRecommendationLink(subjectName: string): { url: string; label: string } {
  const name = (subjectName || "").trim();
  if (!name) return FALLBACK_LINK;
  for (const entry of PROGRAM_RECOMMENDATION_LINKS) {
    if (entry.keywords.some((kw) => name.toLowerCase().includes(kw.toLowerCase()))) {
      return { url: entry.url, label: entry.label };
    }
  }
  return FALLBACK_LINK;
}
