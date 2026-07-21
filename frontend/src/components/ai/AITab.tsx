import { useEffect, useState, useRef } from "react";
import { Loader2, MessageCircle, BookOpen, Send, FileText, ExternalLink } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { aiService, uploadsBaseUrl } from "@/services/api";
import { getProgramRecommendationLink } from "@/constants/programRecommendationLinks";

export type RecommendationItem = {
  subjectId: string;
  subjectName: string;
  reason: string;
  materials: { type: string; description: string }[];
};

export type FailedSubjectMaterial = {
  subjectName: string;
  materials: {
    _id: string;
    title: string;
    description?: string;
    materialType: string;
    category: string;
    storageType: string;
    filePath?: string | null;
    fileName?: string | null;
    url?: string | null;
    uploadedBy?: { firstName?: string; lastName?: string } | null;
    createdAt?: string;
  }[];
};

type AITabProps = {
  /** Optional title override */
  title?: string;
  /** Optional description override */
  description?: string;
};

export function AITab({ title = "AI Assistant", description }: AITabProps) {
  const [recommendations, setRecommendations] = useState<RecommendationItem[]>([]);
  const [materialsForFailedSubjects, setMaterialsForFailedSubjects] = useState<FailedSubjectMaterial[]>([]);
  const [recLoading, setRecLoading] = useState(true);
  const [recMessage, setRecMessage] = useState<string | null>(null);
  const [role, setRole] = useState<"student" | "tutor" | null>(null);

  const [messages, setMessages] = useState<{ role: "user" | "assistant"; text: string }[]>([
    { role: "assistant", text: "Hi! I'm the Bee Bright assistant. Ask about schedules, enrollment, materials, or tutoring—I'll keep it short and relevant." },
  ]);
  const [input, setInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    aiService
      .getRecommendations()
      .then((res) => {
        if (res.data?.success) {
          setRecommendations(res.data.recommendations || []);
          setMaterialsForFailedSubjects(res.data.materialsForFailedSubjects || []);
          setRecMessage(res.data.message || null);
          setRole(res.data.role || null);
        }
      })
      .catch(() => {
        setRecommendations([]);
        setMaterialsForFailedSubjects([]);
        setRecMessage("Could not load recommendations.");
      })
      .finally(() => setRecLoading(false));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || chatLoading) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", text }]);
    setChatLoading(true);
    aiService
      .chat(text)
      .then((res) => {
        if (res.data?.success && res.data.reply) {
          setMessages((prev) => [...prev, { role: "assistant", text: res.data.reply }]);
        } else {
          setMessages((prev) => [...prev, { role: "assistant", text: "I couldn't process that. Try asking about schedule, materials, or enrollment." }]);
        }
      })
      .catch(() => {
        setMessages((prev) => [...prev, { role: "assistant", text: "Something went wrong. Please try again." }]);
      })
      .finally(() => setChatLoading(false));
  };

  const hasFailedMaterials = materialsForFailedSubjects.length > 0;

  const recDescription = description ?? (
    role === "student"
      ? hasFailedMaterials
        ? "You have subjects where your grade is below the passing score. These recommendations focus on tutor materials for those specific topics so you can catch up."
        : "Once your tutor records grades and uploads materials for subjects you find difficult, you’ll see specific recommendations here."
      : role === "tutor"
        ? "Recommend targeted materials to students whose grades show they need extra support in specific topics."
        : "Get personalized recommendations and ask questions about Bee Bright."
  );

  return (
    <div className="space-y-6">
      {/* Recommendations */}
      <Card className="border-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <BookOpen className="h-5 w-5 text-primary" />
            Recommendations
          </CardTitle>
          <CardDescription>{recDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          {recLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (role === "tutor" || role === "student") && recommendations.length > 0 ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {role === "tutor"
                  ? "Resources for the programs you teach. Share these links with students who need extra support."
                  : "Resources for your enrolled programs. Use these links to strengthen your understanding."}
              </p>
              <ul className="space-y-3">
                {recommendations.map((rec) => {
                  const link = getProgramRecommendationLink(rec.subjectName);
                  return (
                    <li key={rec.subjectId}>
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 text-sm text-primary hover:underline font-medium"
                      >
                        <ExternalLink className="h-4 w-4 shrink-0" />
                        <span>{rec.subjectName}</span>
                        <span className="text-muted-foreground font-normal">— {link.label}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
              {role === "student" && materialsForFailedSubjects.length > 0 && (
                <div className="mt-6 pt-4 border-t border-border">
                  <h4 className="text-sm font-semibold text-foreground mb-3">
                    Materials for subjects you need extra support in
                  </h4>
                  <p className="text-xs text-muted-foreground mb-3">
                    These are materials from your tutor that match subjects where your grades are below the passing score.
                  </p>
                  <div className="space-y-4">
                    {materialsForFailedSubjects.map((group) => (
                      <Card key={group.subjectName} className="bg-destructive/5 border-destructive/20">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-base">{group.subjectName}</CardTitle>
                        </CardHeader>
                        <CardContent className="pt-0">
                          <ul className="space-y-2">
                            {group.materials.map((m) => {
                              const href =
                                m.storageType === "file" && m.filePath
                                  ? `${uploadsBaseUrl}/uploads/${m.filePath}`
                                  : m.url || "#";
                              const isExternal = !!m.url;
                              return (
                                <li key={m._id}>
                                  <a
                                    href={href}
                                    target={isExternal ? "_blank" : undefined}
                                    rel={isExternal ? "noopener noreferrer" : undefined}
                                    className="flex items-center gap-2 text-sm text-primary hover:underline"
                                  >
                                    <FileText className="h-4 w-4 shrink-0" />
                                    <span className="font-medium">{m.title}</span>
                                    {isExternal && <ExternalLink className="h-3 w-3" />}
                                  </a>
                                  {m.description && (
                                    <p className="text-xs text-muted-foreground ml-6 mt-0.5">
                                      {m.description}
                                    </p>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : materialsForFailedSubjects.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {recMessage ?? "No recommended materials yet. Once your tutor records grades and uploads materials for subjects you find difficult, they will appear here."}
            </p>
          ) : (
            <div className="space-y-6">
              <div>
                <h4 className="text-sm font-semibold text-foreground mb-3">
                  Materials for subjects you need extra support in
                </h4>
                <p className="text-xs text-muted-foreground mb-3">
                  These are materials from your tutor that match subjects where your grades are below the passing score.
                </p>
                <div className="space-y-4">
                  {materialsForFailedSubjects.map((group) => (
                    <Card key={group.subjectName} className="bg-destructive/5 border-destructive/20">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-base">{group.subjectName}</CardTitle>
                      </CardHeader>
                      <CardContent className="pt-0">
                        <ul className="space-y-2">
                          {group.materials.map((m) => {
                            const href =
                              m.storageType === "file" && m.filePath
                                ? `${uploadsBaseUrl}/uploads/${m.filePath}`
                                : m.url || "#";
                            const isExternal = !!m.url;
                            return (
                              <li key={m._id}>
                                <a
                                  href={href}
                                  target={isExternal ? "_blank" : undefined}
                                  rel={isExternal ? "noopener noreferrer" : undefined}
                                  className="flex items-center gap-2 text-sm text-primary hover:underline"
                                >
                                  <FileText className="h-4 w-4 shrink-0" />
                                  <span className="font-medium">{m.title}</span>
                                  {isExternal && <ExternalLink className="h-3 w-3" />}
                                </a>
                                {m.description && (
                                  <p className="text-xs text-muted-foreground ml-6 mt-0.5">
                                    {m.description}
                                  </p>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
