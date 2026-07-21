import { Layout } from "@/components/layout/Layout";
import { HeroSection } from "@/components/landing/HeroSection";
import { FeaturesSection } from "@/components/landing/FeaturesSection";
import { ServicesSection } from "@/components/landing/ServicesSection";
import { CTASection } from "@/components/landing/CTASection";

const Index = () => {
  return (
    <Layout>
      <HeroSection />
      <FeaturesSection />
      <ServicesSection />
      <CTASection />
    </Layout>
  );
};

export default Index;
