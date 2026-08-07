import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Baby, BookOpen, GraduationCap, Calendar, ArrowRight, X, CheckCircle2, Clock, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";

// ── Program data based on brochure ─────────────────────────────────────────
const PROGRAMS = [
  {
    id: "toddlers",
    code: "TPG101",
    name: "Toddlers Playgroup",
    tagline: "Give your child a joyful start to a lifelong journey of learning!",
    description:
      "A fun, nurturing group program that helps toddlers develop social skills, creativity, and early learning foundations through play-based activities.",
    schedule: "Playgroup sessions: 8:00 AM – 10:00 AM  &  1:00 PM – 3:00 PM (fixed times)",
    ageRange: "1.5 – 3 years old",
    sessionType: "Group sessions",
    icon: Baby,
    color: "from-pink-500 to-rose-500",
    lightBg: "bg-rose-50 dark:bg-rose-950/20",
    lightBorder: "border-rose-200 dark:border-rose-800",
    // Packages from brochure
    packages: [
      { label: "16 hours",  detail: "8 sessions / 2× per week",  priceFull: 2800 },
      { label: "24 hours",  detail: "12 sessions / 3× per week", priceFull: 4080 },
      { label: "32 hours",  detail: "16 sessions / 4× per week", priceFull: 5280 },
      { label: "40 hours",  detail: "20 sessions / 5× per week", priceFull: 6400 },
    ],
    highlights: [
      "Caring and qualified teachers",
      "Engaging daily activities (arts, crafts, music, play-based learning)",
      "Group activities that build social skills, cooperation, and confidence",
      "Hands-on sensory activities",
      "Music & movement for fun learning",
      "Structured routine for emotional safety",
    ],
  },
  {
    id: "academic",
    code: "ACT102",
    name: "Academic Tutorial",
    tagline: "One-on-one tutoring that makes a difference!",
    description:
      "Guaranteed 1-on-1 tutorial sessions with advancement in lessons, homework assistance, and enhancement across all subjects — from Pre-school to Senior High School.",
    schedule: "Mon – Sat  8:00 AM – 6:00 PM",
    ageRange: "2 years old and up",
    sessionType: "1-on-1 sessions",
    icon: BookOpen,
    color: "from-amber-500 to-yellow-500",
    lightBg: "bg-amber-50 dark:bg-amber-950/20",
    lightBorder: "border-amber-200 dark:border-amber-800",
    packages: [
      { label: "Premier",  detail: "12 sessions / 3× per week",   priceFull: 2400,  note: "Pre-School to Elementary" },
      { label: "Premier",  detail: "12 sessions / 3× per week",   priceFull: 2600,  note: "Junior / Senior High School" },
      { label: "Elite",    detail: "20 sessions / 5× per week",   priceFull: 3800,  note: "Pre-School to Elementary" },
      { label: "Elite",    detail: "20 sessions / 5× per week",   priceFull: 4000,  note: "Junior / Senior High School" },
      { label: "Prestige", detail: "16 sessions / 4× per week",   priceFull: 3120,  note: "Pre-School to Elementary" },
      { label: "Prestige", detail: "16 sessions / 4× per week",   priceFull: 3320,  note: "Junior / Senior High School" },
      { label: "Royalty",  detail: "60 sessions / 3 months",      priceFull: 11000, note: "Pre-School to Elementary" },
      { label: "Royalty",  detail: "60 sessions / 3 months",      priceFull: 11200, note: "Junior / Senior High School" },
    ],
    highlights: [
      "Guaranteed 1-on-1 sessions for focused learning",
      "Advancement in lessons and homework assistance",
      "Well-structured timetable with preferred schedule",
      "Highly competent and friendly teachers",
      "Affordable rates inclusive of all learning materials",
      "Continuous progress tracking and feedback",
      "Air-conditioned facility with free Wi-Fi",
    ],
  },
  {
    id: "examprep",
    code: "EXP106",
    name: "Examination Preparation",
    tagline: "Comprehensive review for improved performance!",
    description:
      "Focused exam review sessions designed to build test mastery, boost confidence, and sharpen test-taking strategies for any major examination.",
    schedule: "Mon – Sat  8:00 AM – 6:00 PM",
    ageRange: "3 years old and up",
    sessionType: "1-on-1 sessions only",
    icon: GraduationCap,
    color: "from-emerald-500 to-teal-500",
    lightBg: "bg-emerald-50 dark:bg-emerald-950/20",
    lightBorder: "border-emerald-200 dark:border-emerald-800",
    packages: [
      { label: "Bright",    detail: "5 sessions",  priceFull: 1250 },
      { label: "Smart",     detail: "6 sessions",  priceFull: 1450 },
      { label: "Brilliant", detail: "8 sessions",  priceFull: 1850 },
      { label: "Genius",    detail: "10 sessions", priceFull: 2200 },
    ],
    highlights: [
      "Focused mock exams and practice tests",
      "Test-taking strategy training",
      "Targeted review of weak areas",
      "1-on-1 personalized review plan",
      "Progress check after every session",
    ],
  },
] as const;

type Program = typeof PROGRAMS[number];

// ── Animation variants ─────────────────────────────────────────────────────
const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.15 } },
};
const cardVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" as const } },
};
const overlayVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
};
const panelVariants = {
  hidden: { opacity: 0, scale: 0.95, y: 20 },
  visible: { opacity: 1, scale: 1, y: 0, transition: { duration: 0.25, ease: "easeOut" as const } },
  exit: { opacity: 0, scale: 0.95, y: 10, transition: { duration: 0.2 } },
};

// ── Detail panel (floating modal) ─────────────────────────────────────────
function ProgramDetail({ program, onClose }: { program: Program; onClose: () => void }) {
  const Icon = program.icon;
  const startingPrice = Math.min(...program.packages.map((p) => p.priceFull));
  const downPayment = Math.ceil(startingPrice * 0.5);

  return (
    <AnimatePresence>
      {/* Backdrop */}
      <motion.div
        key="overlay"
        variants={overlayVariants}
        initial="hidden"
        animate="visible"
        exit="hidden"
        className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
        onClick={onClose}
        aria-modal="true"
        role="dialog"
        aria-label={`${program.name} details`}
      >
        {/* Panel — stop propagation so clicks inside don't close */}
        <motion.div
          key="panel"
          variants={panelVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 z-10 h-8 w-8 rounded-full bg-muted flex items-center justify-center hover:bg-muted/80 transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>

          {/* Header */}
          <div className={`p-6 rounded-t-2xl ${program.lightBg} ${program.lightBorder} border-b`}>
            <div className="flex items-start gap-4">
              <div className={`h-14 w-14 rounded-xl bg-gradient-to-br ${program.color} flex items-center justify-center shadow-lg flex-shrink-0`}>
                <Icon className="h-7 w-7 text-white" />
              </div>
              <div className="min-w-0">
                <h3 className="font-bold text-xl text-foreground leading-tight">{program.name}</h3>
                <p className="text-sm text-muted-foreground italic mt-0.5">"{program.tagline}"</p>
              </div>
            </div>
          </div>

          {/* Body */}
          <div className="p-6 space-y-5">

            {/* Quick info pills */}
            <div className="flex flex-wrap gap-2">
              <span className="flex items-center gap-1.5 text-xs bg-muted px-3 py-1.5 rounded-full">
                <Users className="h-3.5 w-3.5 text-muted-foreground" /> {program.ageRange}
              </span>
              <span className="flex items-center gap-1.5 text-xs bg-muted px-3 py-1.5 rounded-full">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" /> {program.sessionType}
              </span>
              <span className="flex items-center gap-1.5 text-xs bg-muted px-3 py-1.5 rounded-full">
                <Calendar className="h-3.5 w-3.5 text-muted-foreground" /> {program.schedule}
              </span>
            </div>

            {/* Description */}
            <p className="text-sm text-muted-foreground leading-relaxed">{program.description}</p>

            {/* Highlights */}
            <div>
              <p className="font-semibold text-foreground text-sm mb-2">Program Highlights</p>
              <ul className="space-y-1.5">
                {program.highlights.map((h) => (
                  <li key={h} className="flex items-start gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                    {h}
                  </li>
                ))}
              </ul>
            </div>

            {/* Packages */}
            <div>
              <p className="font-semibold text-foreground text-sm mb-2">Available Packages</p>
              <div className="grid gap-2">
                {program.packages.map((pkg, i) => {
                  const down = Math.ceil(pkg.priceFull * 0.5);
                  return (
                    <div
                      key={i}
                      className={`flex items-center justify-between p-3 rounded-lg border ${program.lightBg} ${program.lightBorder}`}
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-sm text-foreground">
                          {pkg.label}
                          {'note' in pkg && pkg.note
                            ? <span className="text-xs text-muted-foreground font-normal ml-1">({pkg.note})</span>
                            : null}
                        </p>
                        <p className="text-xs text-muted-foreground">{pkg.detail}</p>
                      </div>
                      <div className="text-right flex-shrink-0 ml-3">
                        <p className="font-bold text-foreground text-sm">₱{pkg.priceFull.toLocaleString()}</p>
                        <p className="text-xs text-muted-foreground">₱{down.toLocaleString()} down (50%)</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Payment note */}
            <div className="p-3 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 rounded-lg text-xs text-amber-800 dark:text-amber-300">
              <strong>Payment:</strong> 50% down upon enrollment. Remaining 50% is due after completing half of your sessions.
            </div>

            {/* CTA */}
            <Link to="/enroll" onClick={onClose}>
              <Button className="w-full btn-glow" size="lg">
                Enroll in this Program
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// ── Main section ───────────────────────────────────────────────────────────
export const ServicesSection = () => {
  const [selectedProgram, setSelectedProgram] = useState<Program | null>(null);

  return (
    <section className="py-20 bg-gradient-to-b from-background to-muted/30">
      <div className="container mx-auto px-4">

        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-16"
        >
          <span className="text-primary font-semibold text-sm uppercase tracking-wider">
            What We Offer
          </span>
          <h2 className="font-display text-3xl md:text-4xl font-bold mt-2 mb-4">
            Our <span className="gradient-text">Programs</span>
          </h2>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            Three focused programs designed to nurture every child's potential — from toddlers to high school students.
            Click any card to see full details and pricing.
          </p>
        </motion.div>

        {/* Program cards — 3 columns */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto"
        >
          {PROGRAMS.map((program) => {
            const Icon = program.icon;
            const startingPrice = Math.min(...program.packages.map((p) => p.priceFull));
            const downPayment = Math.ceil(startingPrice * 0.5);

            return (
              <motion.button
                key={program.id}
                variants={cardVariants}
                onClick={() => setSelectedProgram(program)}
                className="group relative bg-card rounded-2xl border border-border p-6 hover:shadow-xl transition-all duration-300 hover:-translate-y-1 overflow-hidden text-left w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`View details for ${program.name}`}
              >
                {/* Gradient hover overlay */}
                <div
                  className={`absolute inset-0 bg-gradient-to-br ${program.color} opacity-0 group-hover:opacity-5 transition-opacity duration-300`}
                />

                {/* Icon */}
                <div
                  className={`relative h-14 w-14 rounded-xl bg-gradient-to-br ${program.color} flex items-center justify-center mb-4 shadow-lg`}
                >
                  <Icon className="h-7 w-7 text-white" />
                </div>

                {/* Name + tagline */}
                <h3 className="font-display font-bold text-lg text-foreground mb-1">
                  {program.name}
                </h3>
                <p className="text-xs text-muted-foreground italic mb-3 line-clamp-2">
                  "{program.tagline}"
                </p>

                {/* Description */}
                <p className="text-muted-foreground text-sm mb-4 line-clamp-3">
                  {program.description}
                </p>

                {/* Meta row */}
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                  <Users className="h-3.5 w-3.5 flex-shrink-0" />
                  <span>{program.ageRange}</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4">
                  <Calendar className="h-3.5 w-3.5 flex-shrink-0" />
                  <span>{program.schedule}</span>
                </div>

                {/* Starting price */}
                <div className="flex items-end justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">Starting at</p>
                    <p className="font-bold text-primary text-lg">
                      ₱{startingPrice.toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      ₱{downPayment.toLocaleString()} down (50%)
                    </p>
                  </div>
                  <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${program.lightBg} ${program.lightBorder} border`}>
                    {program.packages.length} packages
                  </span>
                </div>

                {/* "View details" hint */}
                <div className="mt-4 flex items-center gap-1 text-xs text-primary font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                  <span>View details & pricing</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </div>
              </motion.button>
            );
          })}
        </motion.div>

        {/* CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.3, duration: 0.5 }}
          className="text-center mt-12"
        >
          <Link to="/enroll">
            <Button size="lg" className="btn-glow">
              Enroll Now
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </motion.div>
      </div>

      {/* Floating detail panel */}
      {selectedProgram && (
        <ProgramDetail
          program={selectedProgram}
          onClose={() => setSelectedProgram(null)}
        />
      )}
    </section>
  );
};
