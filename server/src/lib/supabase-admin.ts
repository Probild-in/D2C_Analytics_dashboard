export class EmailAlreadyRegisteredError extends Error {}

function getCredentials(): { url: string; serviceRoleKey: string } {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables must be set");
  }
  return { url, serviceRoleKey };
}

export async function createSupabaseUser(email: string, password: string): Promise<{ id: string }> {
  const { url, serviceRoleKey } = getCredentials();
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (res.status === 422) {
    throw new EmailAlreadyRegisteredError("This email is already registered. Log in instead.");
  }
  if (!res.ok) {
    throw new Error(`Supabase user creation failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  return { id: body.id };
}

export async function deleteSupabaseUser(userId: string): Promise<void> {
  try {
    const { url, serviceRoleKey } = getCredentials();
    await fetch(`${url}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    });
  } catch (err) {
    // Swallowed deliberately: this only ever runs as a compensating action after a
    // provisioning failure, inside a catch block. Throwing here would replace the real
    // error with a less useful one about cleanup failing.
    console.error(`Failed to delete orphaned Supabase user ${userId} during signup rollback:`, err);
  }
}
