import PolicyWorkspace from '@/components/policy/PolicyWorkspace';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PolicyWorkspace id={id} />;
}
