import { Suspense } from 'react';
import RunView from '@/components/run/RunView';
import { CardSkeleton } from '@/components/ds/feedback';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<CardSkeleton />}>
      <RunView key={id} id={id} />
    </Suspense>
  );
}
