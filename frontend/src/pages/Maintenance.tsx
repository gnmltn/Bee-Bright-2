import { useNavigate } from "react-router-dom";
import { Construction } from "lucide-react";
import beeMascot from "@/assets/bee-mascot.png";

export default function Maintenance() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6">
      <img src={beeMascot} alt="Bee Bright" className="h-24 w-24 mb-6" />
      <div className="flex items-center gap-3 text-primary mb-2">
        <Construction className="h-10 w-10" />
        <h1 className="font-display text-2xl md:text-3xl font-bold text-foreground">
          System Under Maintenance
        </h1>
      </div>
      <p className="text-muted-foreground text-center max-w-md mb-8">
        We are currently performing scheduled maintenance to improve your experience. Our team is working to restore access as quickly as possible. We apologize for any inconvenience and thank you for your patience.
      </p>
      <button
        type="button"
        onClick={() => navigate(-1)}
        className="text-primary hover:underline font-medium"
      >
        Go Back
      </button>
    </div>
  );
}
