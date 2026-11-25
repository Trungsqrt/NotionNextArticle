import { Suspense } from 'react'
import { requireStudyPageSession } from '../../../lib/study/auth/guard'
import RecallSessionClient from '../../../components/study/RecallSessionClient'
import { RecallSessionSkeleton } from '../../../components/study/StudySkeletons'

export const dynamic = 'force-dynamic'

export default async function StudyFlashcardsPage() {
  await requireStudyPageSession({ returnTo: '/study/flashcards' })

  return (
    <Suspense fallback={<RecallSessionSkeleton />}>
      <RecallSessionClient />
    </Suspense>
  )
}
