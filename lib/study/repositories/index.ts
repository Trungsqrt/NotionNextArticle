/**
 * lib/study/repositories/index.ts — Study System repository bundle factory
 */

import { getStudyNotionConfig, type StudyNotionConfig } from '../config'
import { getDefaultStudyNotionClient, type StudyNotionClient } from '../notion-client'
import type {
  StudyUserRepository,
  ExamCollectionRepository,
  QuestionBankRepository,
  FsrsCardStateRepository,
  ReviewEventRepository,
} from './interfaces'
import { createNotionStudyUserRepository } from './user-repo'
import { createNotionExamCollectionRepository } from './exam-repo'
import { createNotionQuestionBankRepository } from './question-repo'
import { createNotionFsrsCardStateRepository } from './card-state-repo'
import { createNotionReviewEventRepository } from './review-event-repo'

export interface StudyRepositories {
  users: StudyUserRepository
  exams: ExamCollectionRepository
  questions: QuestionBankRepository
  cardStates: FsrsCardStateRepository
  reviewEvents: ReviewEventRepository
}

export function createNotionStudyRepositories(
  client: StudyNotionClient = getDefaultStudyNotionClient(),
  config: StudyNotionConfig = getStudyNotionConfig()
): StudyRepositories {
  return {
    users: createNotionStudyUserRepository(client, config.usersDbId),
    exams: createNotionExamCollectionRepository(client, config.examsDbId),
    questions: createNotionQuestionBankRepository(client, config.questionsDbId),
    cardStates: createNotionFsrsCardStateRepository(client, config.cardStatesDbId),
    reviewEvents: createNotionReviewEventRepository(client, config.reviewEventsDbId),
  }
}

export * from './interfaces'
export * from './mappers'
