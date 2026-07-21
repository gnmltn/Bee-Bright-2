import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { ArrowRight, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import beeMascot from "@/assets/bee-mascot.png";

const benefits = [
  "Personalized learning plans",
  "Experienced and certified tutors",
  "Flexible scheduling options",
  "Progress tracking and reports",
];

export function CTASection() {
  return (
    <section className="py-16 md:py-24 bg-muted relative overflow-hidden">
      {/* Background decorations */}
      <div className="absolute inset-0 honeycomb-bg opacity-30" />
      <div className="absolute top-0 right-0 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />
      <div className="absolute bottom-0 left-0 w-64 h-64 bg-accent/10 rounded-full blur-3xl" />

      <div className="container mx-auto px-4 relative">
        <div className="bg-card rounded-3xl p-8 md:p-12 lg:p-16 shadow-xl border border-border">
          <div className="grid lg:grid-cols-2 gap-8 lg:gap-12 items-center">
            {/* Content */}
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              className="space-y-6"
            >
              <h2 className="font-display text-3xl md:text-4xl lg:text-5xl font-bold leading-tight">
                Ready to Start Your{" "}
                <span className="gradient-text">Learning Journey?</span>
              </h2>
              <p className="text-muted-foreground text-lg">
                Join thousands of students who have achieved academic success with Bee Bright Tutorial Center. Enroll today and unlock your full potential!
              </p>

              <ul className="space-y-3">
                {benefits.map((benefit, index) => (
                  <motion.li
                    key={benefit}
                    initial={{ opacity: 0, x: -10 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: 0.1 * index }}
                    className="flex items-center gap-3"
                  >
                    <CheckCircle className="h-5 w-5 text-success shrink-0" />
                    <span className="text-foreground">{benefit}</span>
                  </motion.li>
                ))}
              </ul>

              <div className="flex flex-col sm:flex-row gap-4 pt-2">
                <Button size="lg" asChild className="btn-glow group">
                  <Link to="/enrollment">
                    Enroll Now
                    <ArrowRight className="ml-2 h-5 w-5 group-hover:translate-x-1 transition-transform" />
                  </Link>
                </Button>
                <Button size="lg" variant="outline" asChild>
                  <Link to="/about">Learn More</Link>
                </Button>
              </div>
            </motion.div>

            {/* Mascot */}
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              className="flex justify-center lg:justify-end"
            >
              <div className="relative">
                <div className="absolute inset-0 bg-primary/20 rounded-full blur-3xl scale-75" />
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
      </div>
    </section>
  );
}
