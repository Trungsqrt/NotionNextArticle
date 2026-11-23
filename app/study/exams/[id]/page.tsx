import { requireStudyPageSession } from '../../../../lib/study/auth/guard'
import StudyNav from '../../../../components/study/StudyNav'
import ExamRunnerClient from '../../../../components/study/ExamRunnerClient'

export const dynamic = 'force-dynamic'

export default async function StudyExamDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const safeId = decodeURIComponent(id || '').slice(0, 128)
  const user = await requireStudyPageSession({
    returnTo: `/study/exams/${encodeURIComponent(safeId)}`,
  })

  return (
    <>
      <StudyNav user={user} />
      <ExamRunnerClient examId={safeId} />
    </>
  )
}
