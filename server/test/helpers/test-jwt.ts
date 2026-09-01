import jwt from "jsonwebtoken";

export function signTestJwt(payload: { sub: string; email: string }) {
  const secret = process.env.SUPABASE_JWT_SECRET ?? "test-secret";
  return jwt.sign(payload, secret, { algorithm: "HS256", expiresIn: "1h" });
}
