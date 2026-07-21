import { motion } from "framer-motion";
import { CheckCircle, Home, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Layout } from "@/components/layout/Layout";
import { Link } from "react-router-dom";

export default function EnrollmentSuccess() {
  return (
    <Layout>
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 via-white to-green-50">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5 }}
          className="max-w-md w-full mx-4"
        >
          <div className="bg-white rounded-2xl shadow-xl border border-green-200 p-8 text-center">
            <div className="mb-6">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.2, type: "spring" }}
                className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4"
              >
                <CheckCircle className="h-10 w-10 text-green-600" />
              </motion.div>
              
              <h1 className="text-2xl font-bold text-gray-900 mb-2">
                Enrollment Successful! 🎉
              </h1>
              <p className="text-gray-600 mb-6">
                Thank you for enrolling with Bee Bright. Your application has been received and is being processed.
              </p>
            </div>

            <div className="space-y-4">
              <div className="p-4 bg-green-50 rounded-lg text-left">
                <h3 className="font-semibold text-green-800 mb-2">What happens next?</h3>
                <ul className="text-sm text-green-700 space-y-1">
                  <li>• Our team will review your application within 24-48 hours</li>
                  <li>• You will receive a confirmation email</li>
                  <li>• A representative will contact you for payment details</li>
                  <li>• Classes will begin on the scheduled start date</li>
                </ul>
              </div>

              <div className="flex flex-col sm:flex-row gap-3 pt-4">
                <Button asChild className="flex-1">
                  <Link to="/dashboard">
                    <User className="mr-2 h-4 w-4" />
                    Go to Dashboard
                  </Link>
                </Button>
                <Button asChild variant="outline" className="flex-1">
                  <Link to="/">
                    <Home className="mr-2 h-4 w-4" />
                    Return Home
                  </Link>
                </Button>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </Layout>
  );
}