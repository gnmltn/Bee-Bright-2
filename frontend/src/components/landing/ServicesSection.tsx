import { motion } from "framer-motion";
import { Baby, BookOpen, Heart, Sparkles, Calendar, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";

const services = [
  {
    id: "toddlers",
    name: "Toddlers Playgroup",
    description: "Fun and engaging activities designed to develop social skills, creativity, and early learning foundations for your little ones.",
    schedule: "Mon, Wed, Fri 9:00 AM - 11:00 AM",
    price: 3000,
    icon: Baby,
    color: "from-pink-500 to-rose-500",
  },
  {
    id: "academic",
    name: "Academic Tutorial",
    description: "Personalized tutoring sessions covering all major subjects to help students excel in their academic journey.",
    schedule: "Mon - Fri 3:00 PM - 5:00 PM",
    price: 2500,
    icon: BookOpen,
    color: "from-primary to-amber-500",
  },
  {
    id: "sped",
    name: "SPED Tutorial",
    description: "Specialized education programs tailored to meet the unique learning needs of children with special requirements.",
    schedule: "Tue, Thu 9:00 AM - 11:00 AM",
    price: 3500,
    icon: Heart,
    color: "from-violet-500 to-purple-500",
  },
  {
    id: "kinder",
    name: "Kindergarten Readiness",
    description: "Comprehensive preparation program to ensure your child is ready and confident for their kindergarten journey.",
    schedule: "Mon, Wed, Fri 1:00 PM - 3:00 PM",
    price: 3000,
    icon: Sparkles,
    color: "from-emerald-500 to-teal-500",
  },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.15,
    },
  },
};

const cardVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.5,
      ease: "easeOut" as const,
    },
  },
};

export const ServicesSection = () => {
  return (
    <section className="py-20 bg-gradient-to-b from-background to-muted/30">
      <div className="container mx-auto px-4">
        {/* Section Header */}
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
            Our <span className="gradient-text">Services</span>
          </h2>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            We provide comprehensive educational programs designed to nurture every child's potential and prepare them for academic success.
          </p>
        </motion.div>

        {/* Services Grid */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          className="grid md:grid-cols-2 lg:grid-cols-4 gap-6"
        >
          {services.map((service) => {
            const Icon = service.icon;
            return (
              <motion.div
                key={service.id}
                variants={cardVariants}
                className="group relative bg-card rounded-2xl border border-border p-6 hover:shadow-xl transition-all duration-300 hover:-translate-y-1 overflow-hidden"
              >
                {/* Gradient background on hover */}
                <div className={`absolute inset-0 bg-gradient-to-br ${service.color} opacity-0 group-hover:opacity-5 transition-opacity duration-300`} />
                
                {/* Icon */}
                <div className={`relative h-14 w-14 rounded-xl bg-gradient-to-br ${service.color} flex items-center justify-center mb-4 shadow-lg`}>
                  <Icon className="h-7 w-7 text-white" />
                </div>

                {/* Content */}
                <h3 className="font-display font-bold text-lg text-foreground mb-2">
                  {service.name}
                </h3>
                <p className="text-muted-foreground text-sm mb-4 line-clamp-3">
                  {service.description}
                </p>

                {/* Schedule */}
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
                  <Calendar className="h-3.5 w-3.5" />
                  <span>{service.schedule}</span>
                </div>

                {/* Price */}
                <div className="flex items-center justify-between">
                  <span className="font-bold text-primary text-lg">
                    ₱{service.price.toLocaleString()}
                    <span className="text-xs text-muted-foreground font-normal">/mo</span>
                  </span>
                </div>
              </motion.div>
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
          <Link to="/enrollment">
            <Button size="lg" className="btn-glow">
              Enroll Now
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </motion.div>
      </div>
    </section>
  );
};
