import { Link } from "react-router-dom";
import { MapPin, Phone, Mail, Facebook, Instagram } from "lucide-react";
import beeMascot from "@/assets/bee-mascot.png";

const FACEBOOK_URL = "https://www.facebook.com/beeberightphmain";
const INSTAGRAM_URL = "https://www.instagram.com/beebrightph_/?hl=en";

const footerLinks = {
  quickLinks: [
    { name: "Home", href: "/" },
    { name: "About Us", href: "/about" },
    { name: "Enrollment", href: "/enrollment" },
  ],
  portals: [
    { name: "Student Login", href: "/login" },
    { name: "Tutor Login", href: "/login" },
  ],
};

export function Footer() {
  return (
    <footer className="bg-gray-950 text-gray-100">
      <div className="container mx-auto px-4 py-12 md:py-16">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 md:gap-12">
          {/* Brand */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <img src={beeMascot} alt="Bee Bright" className="h-10 w-10" />
              <span className="font-display font-bold text-2xl">
                <span className="text-primary">Bee</span> Bright
              </span>
            </div>
            <p className="text-gray-400 text-sm leading-relaxed">
              Empowering students to achieve academic excellence through personalized tutoring and innovative learning solutions.
            </p>
            <div className="flex items-center gap-4">
              <a href={FACEBOOK_URL} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-primary transition-colors" aria-label="Facebook">
                <Facebook className="h-5 w-5" />
              </a>
              <a href={INSTAGRAM_URL} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-primary transition-colors" aria-label="Instagram">
                <Instagram className="h-5 w-5" />
              </a>
            </div>
          </div>

          {/* Quick Links */}
          <div>
            <h4 className="font-display font-bold text-lg mb-4">Quick Links</h4>
            <ul className="space-y-2">
              {footerLinks.quickLinks.map((link) => (
                <li key={link.name}>
                  <Link
                    to={link.href}
                    className="text-gray-400 hover:text-primary transition-colors text-sm"
                  >
                    {link.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Portals */}
          <div>
            <h4 className="font-display font-bold text-lg mb-4">Portals</h4>
            <ul className="space-y-2">
              {footerLinks.portals.map((link) => (
                <li key={link.name}>
                  <Link
                    to={link.href}
                    className="text-gray-400 hover:text-primary transition-colors text-sm"
                  >
                    {link.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h4 className="font-display font-bold text-lg mb-4">Contact Us</h4>
            <ul className="space-y-3">
              <li className="flex items-start gap-3 text-sm">
                <MapPin className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                <span className="text-gray-400">
                  Dagupan City, Pangasinan, Philippines
                </span>
              </li>
              <li className="flex items-center gap-3 text-sm">
                <Phone className="h-5 w-5 text-primary shrink-0" />
                <span className="text-gray-400">+63 912 345 6789</span>
              </li>
              <li className="flex items-center gap-3 text-sm">
                <Mail className="h-5 w-5 text-primary shrink-0" />
                <span className="text-gray-400">info@beebright.edu.ph</span>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-12 pt-8 border-t border-gray-800 flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-gray-500">
          <p>© 2025 Bee Bright Tutorial Center. All rights reserved.</p>
          <p>Dagupan City, Pangasinan</p>
        </div>
      </div>
    </footer>
  );
}
