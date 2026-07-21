import { motion } from "framer-motion";
import {
  GraduationCap,
  Calendar,
  Users,
  BookOpen,
  TrendingUp,
  CreditCard,
  ClipboardCheck,
  BarChart3,
} from "lucide-react";

const features = [
  {
    icon: GraduationCap,
    title: "Expert Tutors",
    description: "Learn from qualified and experienced educators dedicated to your success.",
    color: "bg-primary/10 text-primary",
  },
  {
    icon: Calendar,
    title: "Flexible Scheduling",
    description: "Book sessions that fit your schedule with our easy-to-use scheduling system.",
    color: "bg-info/10 text-info",
  },
  {
    icon: Users,
    title: "Small Class Sizes",
    description: "Personalized attention with optimal student-to-tutor ratios.",
    color: "bg-success/10 text-success",
  },
  {
    icon: BookOpen,
    title: "Learning Materials",
    description: "Access comprehensive study materials and resources anytime.",
    color: "bg-accent/10 text-accent",
  },
  {
    icon: TrendingUp,
    title: "Progress Tracking",
    description: "Monitor your academic growth with detailed progress reports.",
    color: "bg-primary/10 text-primary",
  },
  {
    icon: CreditCard,
    title: "Easy Payments",
    description: "Convenient payment options with transparent invoicing.",
    color: "bg-info/10 text-info",
  },
  {
    icon: ClipboardCheck,
    title: "Attendance Monitoring",
    description: "Track attendance and ensure consistent learning participation.",
    color: "bg-success/10 text-success",
  },
  {
    icon: BarChart3,
    title: "Performance Analytics",
    description: "Data-driven insights to identify strengths and areas for improvement.",
    color: "bg-accent/10 text-accent",
  },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5 },
  },
};

export function FeaturesSection() {
  return (
    <section className="py-16 md:py-24 bg-background">
      <div className="container mx-auto px-4">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center max-w-2xl mx-auto mb-12 md:mb-16"
        >
          <span className="text-primary font-semibold text-sm uppercase tracking-wider">
            Why Choose Us
          </span>
          <h2 className="font-display text-3xl md:text-4xl lg:text-5xl font-bold mt-2 mb-4">
            Everything You Need to{" "}
            <span className="gradient-text">Succeed</span>
          </h2>
          <p className="text-muted-foreground text-lg">
            Our comprehensive tutorial system provides all the tools and support you need for academic excellence.
          </p>
        </motion.div>

        {/* Features Grid */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6"
        >
          {features.map((feature, index) => (
            <motion.div
              key={feature.title}
              variants={itemVariants}
              className="group p-6 bg-card rounded-xl border border-border hover:border-primary/30 transition-all duration-300 card-hover"
            >
              <div
                className={`inline-flex items-center justify-center h-12 w-12 rounded-lg ${feature.color} mb-4 group-hover:scale-110 transition-transform`}
              >
                <feature.icon className="h-6 w-6" />
              </div>
              <h3 className="font-display font-bold text-lg mb-2 text-foreground">
                {feature.title}
              </h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {feature.description}
              </p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
