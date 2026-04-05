import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/nextjs";

export default function RootLayout({ children }: { children: ReactNode }) {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  const content = publishableKey ? (
    <ClerkProvider publishableKey={publishableKey}>{children}</ClerkProvider>
  ) : (
    children
  );

  return (
    <html lang="en">
      <body>{content}</body>
    </html>
  );
}
