import { getAuthToken } from "@/utils/authStorage";

type ApiError = Error & {
  response?: {
    status: number;
    data: {
      success?: boolean;
      message?: string;
    };
  };
};

type RequestCodeResponse = {
  success: boolean;
  message?: string;
  verificationId: string;
  expiresAt: string;
  maskedEmail: string;
};

type VerifyCodeResponse = {
  success: boolean;
  message?: string;
  verificationId: string;
  verificationToken: string;
  expiresAt: string;
};

type CreateVerifiedAdminPayload = {
  firstName: string;
  middleName?: string;
  lastName: string;
  email: string;
  password: string;
  phone: string;
  verificationId: string;
  verificationToken: string;
};

type CreateVerifiedTutorPayload = {
  firstName: string;
  middleName?: string;
  lastName: string;
  email: string;
  password: string;
  phone: string;
  subjectsTaught: string[];
  employmentType: "full-time" | "part-time";
  availability: string;
  verificationId: string;
  verificationToken: string;
};

type CreateVerifiedAdminResponse = {
  success: boolean;
  message?: string;
  user?: {
    _id: string;
    firstName: string;
    middleName?: string;
    lastName: string;
    email: string;
    phone?: string;
    role: string;
    isActive?: boolean;
  };
};

type CreateVerifiedTutorResponse = {
  success: boolean;
  message?: string;
  user?: {
    _id: string;
    firstName: string;
    middleName?: string;
    lastName: string;
    email: string;
    phone?: string;
    role: string;
    isActive?: boolean;
    subjectsTaught?: string[];
    employmentType?: "full-time" | "part-time";
    availability?: string;
  };
};

const configuredBaseUrl = String(
  import.meta.env.VITE_API_URL ||
    import.meta.env.VITE_API_BASE_URL ||
    "http://localhost:5001/api"
).replace(/\/$/, "");

const apiRoot = configuredBaseUrl.endsWith("/api")
  ? configuredBaseUrl
  : `${configuredBaseUrl}/api`;

async function postJson<TResponse>(
  path: string,
  payload: Record<string, unknown>
): Promise<TResponse> {
  const token = getAuthToken();
  const response = await fetch(`${apiRoot}${path}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  const data = (await response.json().catch(() => ({
    success: false,
    message: "Invalid server response.",
  }))) as TResponse & { success?: boolean; message?: string };

  if (!response.ok) {
    const error: ApiError = new Error(data.message || "Request failed.");
    error.response = {
      status: response.status,
      data,
    };
    throw error;
  }

  return Object.assign({ data }, data) as TResponse;
}

export const adminEmailVerificationService = {
  requestCode(email: string) {
    return postJson<RequestCodeResponse>("/admin-invites/request-code", {
      email,
    });
  },
  requestTutorCode(email: string) {
    return postJson<RequestCodeResponse>("/admin-invites/tutor/request-code", {
      email,
    });
  },
  verifyCode(payload: {
    email: string;
    code: string;
    verificationId: string;
  }) {
    return postJson<VerifyCodeResponse>("/admin-invites/verify-code", payload);
  },
  verifyTutorCode(payload: {
    email: string;
    code: string;
    verificationId: string;
  }) {
    return postJson<VerifyCodeResponse>(
      "/admin-invites/tutor/verify-code",
      payload
    );
  },
  createVerifiedAdmin(payload: CreateVerifiedAdminPayload) {
    return postJson<CreateVerifiedAdminResponse>(
      "/admin-invites/create-admin",
      payload
    );
  },
  createVerifiedTutor(payload: CreateVerifiedTutorPayload) {
    return postJson<CreateVerifiedTutorResponse>(
      "/admin-invites/tutor/create",
      payload
    );
  },
};
