import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { isStudyAuthConfigured } from '../../../lib/study/config'
import { getStudyPageSession } from '../../../lib/study/auth/guard'
import LoginForm from '../../../components/study/LoginForm'

export const dynamic = 'force-dynamic'

export default async function StudyLoginPage() {
  const existingUser = await getStudyPageSession()
  if (existingUser) {
    redirect('/study')
  }

  return (
    <Suspense fallback={null}>
      <LoginForm isConfigured={isStudyAuthConfigured()} />
    </Suspense>
  )
}
