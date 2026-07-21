import { motion } from "framer-motion";
import {
  Target,
  Lightbulb,
  Heart,
  Users,
  Award,
  BookOpen,
  TrendingUp,
  Shield,
} from "lucide-react";
import { Layout } from "@/components/layout/Layout";
import beeMascot from "@/assets/bee-mascot.png";

const objectives = [
  {
    icon: Target,
    title: "Improve Academic Performance",
    description: "Help students achieve better grades through personalized tutoring and targeted learning strategies.",
  },
  {
    icon: Lightbulb,
    title: "Foster Critical Thinking",
    description: "Develop analytical and problem-solving skills that extend beyond the classroom.",
  },
  {
    icon: Heart,
    title: "Build Confidence",
    description: "Create a supportive environment where students feel empowered to ask questions and learn.",
  },
  {
    icon: Users,
    title: "Personalized Attention",
    description: "Provide one-on-one and small group sessions tailored to individual learning styles.",
  },
];

const impacts = [
  {
    icon: Users,
    title: "For Students",
    description: "More organized and engaging learning experience with easy access to schedules, materials, and progress updates.",
    color: "bg-primary/10 text-primary",
  },
  {
    icon: Shield,
    title: "For Staff",
    description: "Structured process for managing transactions, reducing stress and allowing focus on core responsibilities.",
    color: "bg-info/10 text-info",
  },
  {
    icon: Award,
    title: "For the Center",
    description: "Enhanced reputation through modern technology adoption, attracting more students and improving operations.",
    color: "bg-success/10 text-success",
  },
];

const values = [
  { icon: BookOpen, label: "Quality Education" },
  { icon: Users, label: "Student-Centered" },
  { icon: TrendingUp, label: "Continuous Improvement" },
  { icon: Award, label: "Excellence" },
];

export default function AboutPage() {
  return (
    <Layout>
      {/* Hero Section */}
      <section className="relative py-16 md:py-24 bg-gradient-to-br from-muted via-background to-muted overflow-hidden">
        <div className="absolute inset-0 bee-pattern opacity-30" />
        <div className="container mx-auto px-4 relative">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <motion.div
              initial={{ opacity: 0, x: -30 }}
              animate={{ opacity: 1, x: 0 }}
              className="space-y-6"
            >
              <span className="text-primary font-semibold text-sm uppercase tracking-wider">
                About Us
              </span>
              <h1 className="font-display text-4xl md:text-5xl font-bold leading-tight">
                Empowering Minds,{" "}
                <span className="gradient-text">Brightening Futures</span>
              </h1>
              <p className="text-lg text-muted-foreground leading-relaxed">
                Bee Bright Tutorial Center is dedicated to providing quality educational support to students in Dagupan City, Pangasinan. Our mission is to create a nurturing learning environment where every student can thrive academically and personally.
              </p>
              <p className="text-muted-foreground leading-relaxed">
                Founded with the vision of making quality tutoring accessible, we combine experienced educators with innovative teaching methods to deliver personalized learning experiences that make a real difference.
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex justify-center"
            >
              <div className="relative">
                <div className="absolute inset-0 bg-primary/20 rounded-full blur-3xl" />
                <motion.img
                  src={beeMascot}
                  alt="Bee Bright Mascot"
                  className="relative h-64 w-64 md:h-80 md:w-80 drop-shadow-2xl"
                  animate={{ y: [0, -15, 0] }}
                  transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
                />
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* Objectives Section */}
      <section className="py-16 md:py-24 bg-background">
        <div className="container mx-auto px-4">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center max-w-2xl mx-auto mb-12"
          >
            <span className="text-primary font-semibold text-sm uppercase tracking-wider">
              Our Mission
            </span>
            <h2 className="font-display text-3xl md:text-4xl font-bold mt-2 mb-4">
              Objectives of <span className="gradient-text">Bee Bright</span>
            </h2>
            <p className="text-muted-foreground text-lg">
              We are committed to transforming education through innovation and personalized care.
            </p>
          </motion.div>

          <div className="grid md:grid-cols-2 gap-6">
            {objectives.map((objective, index) => (
              <motion.div
                key={objective.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
                className="flex gap-4 p-6 bg-card rounded-xl border border-border card-hover"
              >
                <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <objective.icon className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h3 className="font-display font-bold text-lg mb-2 text-foreground">
                    {objective.title}
                  </h3>
                  <p className="text-muted-foreground text-sm leading-relaxed">
                    {objective.description}
                  </p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Impact Section */}
      <section className="py-16 md:py-24 bg-muted">
        <div className="container mx-auto px-4">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center max-w-2xl mx-auto mb-12"
          >
            <span className="text-primary font-semibold text-sm uppercase tracking-wider">
              Our Impact
            </span>
            <h2 className="font-display text-3xl md:text-4xl font-bold mt-2 mb-4">
              Making a <span className="gradient-text">Difference</span>
            </h2>
            <p className="text-muted-foreground text-lg">
              See how Bee Bright positively impacts students, staff, and the community.
            </p>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-6">
            {impacts.map((impact, index) => (
              <motion.div
                key={impact.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
                className="bg-card rounded-xl p-8 border border-border text-center card-hover"
              >
                <div
                  className={`h-16 w-16 rounded-full ${impact.color} flex items-center justify-center mx-auto mb-4`}
                >
                  <impact.icon className="h-8 w-8" />
                </div>
                <h3 className="font-display font-bold text-xl mb-3 text-foreground">
                  {impact.title}
                </h3>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  {impact.description}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Values Section */}
      <section className="py-16 md:py-24 bg-background">
        <div className="container mx-auto px-4">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-12"
          >
            <h2 className="font-display text-3xl md:text-4xl font-bold">
              Our Core <span className="gradient-text">Values</span>
            </h2>
          </motion.div>

          <div className="flex flex-wrap justify-center gap-4 md:gap-6">
            {values.map((value, index) => (
              <motion.div
                key={value.label}
                initial={{ opacity: 0, scale: 0.8 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
                className="flex items-center gap-3 px-6 py-4 bg-card rounded-full border border-border shadow-sm"
              >
                <value.icon className="h-5 w-5 text-primary" />
                <span className="font-semibold text-foreground">{value.label}</span>
              </motion.div>
            ))}
          </div>
        </div>
      </section>
    </Layout>
  );
}
