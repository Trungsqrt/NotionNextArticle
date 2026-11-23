import { requireStudyPageSession } from '../../../../lib/study/auth/guard'
import ExamRunnerClient from '../../../../components/study/ExamRunnerClient'

export const dynamic = 'force-dynamic'

export default async function StudyExamDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const safeId = decodeURIComponent(id || '').slice(0, 128)
  await requireStudyPageSession({
    returnTo: `/study/exams/${encodeURIComponent(safeId)}`,
  })

  return <ExamRunnerClient examId={safeId} />
}
