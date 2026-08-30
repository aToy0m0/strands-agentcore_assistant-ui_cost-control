const contacts = Object.freeze({
  sales: Object.freeze({ department: "sales", email: "sales@example.com", hours: "平日 09:00-17:00 JST" }),
  support: Object.freeze({ department: "support", email: "support@example.com", hours: "平日 09:00-18:00 JST" }),
  billing: Object.freeze({ department: "billing", email: "billing@example.com", hours: "平日 10:00-17:00 JST" }),
});

export async function handler(event) {
  if (typeof event !== "object" || event === null || typeof event.department !== "string") {
    throw new Error("department must be a string");
  }
  const department = event.department.trim().toLowerCase();
  const contact = contacts[department];
  if (!contact) throw new Error("department must be one of: sales, support, billing");
  return contact;
}
