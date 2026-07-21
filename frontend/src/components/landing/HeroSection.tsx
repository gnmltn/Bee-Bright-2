import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { ArrowRight, Sparkles, Award } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dashboardService } from "@/services/api";
import beeMascot from "@/assets/bee-mascot.png";
import heroStudents from "@/assets/hero-students.jpg";

export function HeroSection() {
  const [monthlyNewStudents, setMonthlyNewStudents] = useState<number | null>(null);

  useEffect(() => {
    let mounted = true;

    dashboardService
      .getPublicStats()
      .then((res) => {
        if (!mounted) return;
        if (res.data?.success && typeof res.data?.stats?.monthlyNewStudents === "number") {
          setMonthlyNewStudents(res.data.stats.monthlyNewStudents);
        }
      })
      .catch(() => {
        if (!mounted) return;
        setMonthlyNewStudents(null);
      });

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <section className="relative overflow-hidden bg-gradient-to-br from-background via-muted to-background">
      {/* Decorative elements */}
      <div className="absolute inset-0 bee-pattern opacity-50" />
      <div className="absolute top-20 right-10 w-64 h-64 bg-primary/10 rounded-full blur-3xl" />
      <div className="absolute bottom-20 left-10 w-96 h-96 bg-accent/10 rounded-full blur-3xl" />

      <div className="container mx-auto px-4 py-12 md:py-20 lg:py-28 relative">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          {/* Content */}
          <motion.div
            initial={{ opacity: 0, x: -30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6 }}
            className="space-y-6 md:space-y-8 text-center lg:text-left"
          >
            {/* Badge */}
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="inline-flex items-center gap-2 px-4 py-2 bg-primary/10 rounded-full text-primary text-sm font-medium"
            >
              <Sparkles className="h-4 w-4" />
              <span>Welcome to Bee Bright Tutorial Center</span>
            </motion.div>

            <h1 className="font-display text-4xl md:text-5xl lg:text-6xl font-bold leading-tight">
              Where Learning{" "}
              <span className="gradient-text">Comes Alive</span>
            </h1>

            <p className="text-lg md:text-xl text-muted-foreground max-w-lg mx-auto lg:mx-0">
              Empowering students with personalized tutoring, expert guidance, and innovative learning solutions. Join our community of achievers today!
            </p>

            {/* CTA Buttons */}
            <div className="flex flex-col sm:flex-row items-center gap-4 justify-center lg:justify-start">
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

          {/* Image */}
          <motion.div
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="relative"
          >
            {/* Main image */}
            <div className="relative rounded-2xl overflow-hidden shadow-2xl">
              <img
                src={heroStudents}
                alt="Students learning at Bee Bright"
                className="w-full h-auto object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-foreground/20 to-transparent" />
            </div>

            {/* Floating mascot */}
            <motion.div
              animate={{ y: [0, -10, 0] }}
              transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
              className="absolute -bottom-6 -left-6 md:-bottom-8 md:-left-8"
            >
              <div className="relative">
                <div className="absolute inset-0 bg-primary/20 rounded-full blur-xl" />
                <img
                  src={beeMascot}
                  alt="Bee mascot"
                  className="relative h-24 w-24 md:h-32 md:w-32 drop-shadow-xl"
                />
              </div>
            </motion.div>

            {/* Floating card */}
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.6 }}
              className="absolute -top-4 -right-4 md:-top-6 md:-right-6 bg-card rounded-xl p-4 shadow-lg border border-border"
            >
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-success/20 flex items-center justify-center">
                  <Award className="h-5 w-5 text-success" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">This Month</p>
                  <p className="font-semibold text-foreground">
                    {monthlyNewStudents == null
                      ? "New Students"
                      : `${monthlyNewStudents.toLocaleString()} New Students`}
                  </p>
                </div>
              </div>
            </motion.div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
