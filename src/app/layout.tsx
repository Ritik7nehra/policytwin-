import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/jetbrains-mono';
import './globals.css';
import { SessionProvider } from '@/components/shell/SessionProvider';
import { ToastProvider } from '@/components/ds/Toast';
import { TooltipProvider } from '@/components/ds/overlays';
import { DemoProvider } from '@/components/shell/DemoRunner';
import AppShell from '@/components/shell/AppShell';
import { TAGLINE } from '@/lib/disclosures';

export const metadata: Metadata = {
  title: { default: 'PayPal PolicyTwin — counterfactual testing for financial-policy releases', template: '%s · PayPal PolicyTwin' },
  description: TAGLINE,
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#071A33' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <TooltipProvider>
          <ToastProvider>
            <SessionProvider>
              <DemoProvider>
                <AppShell>{children}</AppShell>
              </DemoProvider>
            </SessionProvider>
          </ToastProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
