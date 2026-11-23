import { requireStudyPageSession } from '../../lib/study/auth/guard'
import StudyDashboardClient from '../../components/study/StudyDashboardClient'

export const dynamic = 'force-dynamic'

export default async function StudyHomePage() {
  await requireStudyPageSession({ returnTo: '/study' })

  return <StudyDashboardClient />
}
