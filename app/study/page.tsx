import { requireStudyPageSession } from '../../lib/study/auth/guard'
import StudyNav from '../../components/study/StudyNav'
import StudyDashboardClient from '../../components/study/StudyDashboardClient'

export const dynamic = 'force-dynamic'

export default async function StudyHomePage() {
  const user = await requireStudyPageSession({ returnTo: '/study' })

  return (
    <>
      <StudyNav user={user} />
      <StudyDashboardClient />
    </>
  )
}
