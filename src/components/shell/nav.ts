import { Activity, FileText, FolderGit2, LayoutDashboard, Play, PlusCircle, ScrollText, type LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  match: (p: string) => boolean;
}

/** Every item routes to a real page. */
export const NAV: NavItem[] = [
  { href: '/', label: 'Overview', hint: 'Start here', icon: LayoutDashboard, match: (p) => p === '/' },
  { href: '/policies', label: 'Policy changes', hint: 'All policy changes', icon: FolderGit2, match: (p) => p === '/policies' || (p.startsWith('/policies/') && p !== '/policies/new') },
  { href: '/policies/new', label: 'New policy change', hint: 'Three-step wizard', icon: PlusCircle, match: (p) => p === '/policies/new' },
  { href: '/runs', label: 'Test runs', hint: 'Matrix, evidence, verdicts', icon: Play, match: (p) => p === '/runs' || p.startsWith('/runs/') },
  { href: '/evidence', label: 'Evidence', hint: 'Sandbox & shadow proofs', icon: ScrollText, match: (p) => p === '/evidence' },
  { href: '/reports', label: 'Reports', hint: 'Shareable HTML reports', icon: FileText, match: (p) => p === '/reports' },
  { href: '/status', label: 'System status', hint: 'Modes, dependencies, queue', icon: Activity, match: (p) => p === '/status' },
];
