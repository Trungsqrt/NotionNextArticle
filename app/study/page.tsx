import { requireStudyPageSession } from '../../lib/study/auth/guard'
import { createNotionStudyRepositories } from '../../lib/study/repositories'
import {
  getStudyDashboardCatalog,
  type StudyDashboardCatalog,
} from '../../lib/study/services/dashboard-service'
import StudyDashboardClient from '../../components/study/StudyDashboardClient'

export const dynamic = 'force-dynamic'

export default async function StudyHomePage() {
  const user = await requireStudyPageSession({ returnTo: '/study' })

  let initialCatalog: StudyDashboardCatalog | null = null
  try {
    const repos = createNotionStudyRepositories()
    initialCatalog = await getStudyDashboardCatalog(repos)
  } catch {
    initialCatalog = null
  }

  return (
    <StudyDashboardClient
      userId={user.userId}
      initialCatalog={initialCatalog}
    />
  )
}
