/**
 * Program-specific recommendation links for tutors.
 * Maps program/subject names (from API) to curated resource URLs.
 * ONLY the 3 active programs — TPG101, ACT102, EXP106 (see constants/programs.ts).
 * Pre-Kindergarten Readiness / Kindergarten Readiness / SPED Tutorial were their
 * own retired programs (PKR105/KRP104/SPT103) and no longer have dedicated
 * entries; Pre-K/SPED support is now offered as part of Academic Tutorial.
 */
export const PROGRAM_RECOMMENDATION_LINKS: { keywords: string[]; url: string; label: string }[] = [
  {
    keywords: ["Toddlers Playgroup", "Toddler"],
    url: "https://www.khanacademy.org/early-math",
    label: "Early Math & Readiness Resources",
  },
  {
    keywords: ["Academic Tutorial", "Academic"],
    url: "https://www.khanacademy.org",
    label: "Academic Subject Resources (Math, Science, English)",
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
