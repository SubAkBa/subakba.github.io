# Developer Portfolio

손원주의 백엔드 개발 경력과 Engineering Projects를 소개하는 정적 포트폴리오입니다. 프로젝트 문서는 기술 블로그 게시글이 아닌 공개 가능한 경력기술서로 작성합니다.

## Tech Stack

- Astro 7, TypeScript, Astro Content Collections
- Markdown, CSS Custom Properties, Shiki 코드 구문 강조
- GitHub Actions, GitHub Pages

## Local Development

Node.js 22.12 이상과 npm이 필요합니다.

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

빌드 결과는 `dist/`에 생성됩니다. `npm run preview`는 정적 빌드 결과를 로컬에서 확인합니다.

## Project Structure

```text
src/
├── components/             # 화면 섹션, 카드, 테마 및 이력서 링크
├── content/projects/       # Engineering Project Markdown 문서
├── content.config.ts       # Content Collection 스키마
├── layouts/BaseLayout.astro # 공통 SEO, 테마 초기화
├── lib/projects.ts         # 공개/대표 프로젝트 필터와 정렬
├── pages/                  # 홈, 프로젝트 목록·상세, 404, robots.txt
└── styles/global.css       # 테마 토큰과 반응형 스타일
public/
├── favicon.svg
├── og-image.png            # 기본 소셜 미리보기 이미지
├── images/                 # 선택적 프로필·프로젝트 이미지
└── resume/                 # 선택적 이력서 PDF
.github/workflows/deploy.yml # GitHub Pages 자동 배포
astro.config.mjs            # 배포 URL과 사이트맵 설정
```

## Adding Engineering Projects

`src/content/projects/`에 영문 소문자와 하이픈으로 된 `.md` 파일을 추가합니다. 파일명이 `/projects/{slug}`의 slug가 됩니다. 페이지 컴포넌트를 따로 만들 필요가 없습니다.

```md
---
title: "프로젝트 제목"
company: "공개 가능한 회사명"
period: "202X.XX ~ 202X.XX"
category: "Cache Architecture"
summary: "한 문장 요약"
skills:
  - Java
  - Redis
featured: false
order: 2
draft: true
---

## Overview

공개 가능한 프로젝트 개요를 작성합니다.
```

- `title`, `company`, `period`, `category`, `summary`, `skills`, `featured`, `order`, `draft`는 필수입니다. `role`, `thumbnail`, `repository`는 선택 사항입니다.
- `draft: true`인 문서는 production 목록, 메인, 상세 URL과 사이트맵에 포함되지 않습니다. 게시할 때 `false`로 바꿉니다.
- `featured: true`인 공개 프로젝트는 메인에도 표시됩니다. 목록과 메인은 `order` 오름차순입니다.
- `##`/`###` 제목은 데스크톱 목차에 사용됩니다. 언어가 지정된 코드 펜스에는 구문 강조, 언어 표시, 복사 버튼이 적용됩니다.
- 구조도는 `public/images/projects/{slug}/`에 저장하고 Markdown에서 `![구조 설명](/images/projects/{slug}/diagram.png)`처럼 참조합니다.
- 현재 회사의 내부 서비스명, 주소·도메인, DB 스키마·테이블, 고객 데이터, 내부 API, 인증 정보, 코드 원문을 게시하지 않습니다. 코드 예시는 일반화한 샘플임을 명시하고, 확인되지 않은 수치나 결과를 만들지 않습니다.

## Resume

실제 공개할 PDF를 `public/resume/resume.pdf`에 추가합니다. 파일이 없으면 헤더와 Hero에 **준비 중**으로 표시되며 빌드는 정상적으로 완료됩니다. 파일을 추가하고 다시 빌드하면 이력서 링크가 활성화되어 새 탭에서 PDF를 엽니다. 이 UI는 `src/components/ResumeLink.astro`에 모여 있습니다.

프로필 사진은 선택 사항입니다. `public/images/profile.webp`를 추가하면 Hero의 프로필 영역에 자동으로 표시됩니다. 이미지가 없어도 레이아웃은 완성된 상태로 보입니다. 이미지 사용 시 표시 크기에 맞춰 압축하고 적절한 얼굴 중심 크롭을 권장합니다.

## Deployment

`main` 브랜치로 변경 사항을 푸시하면 `.github/workflows/deploy.yml`이 공식 Astro GitHub Action으로 빌드하고 GitHub Pages에 배포합니다. 저장소 `subakba/subakba.github.io`의 **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 설정해야 합니다.

기본 주소는 `https://subakba.github.io`입니다. `npm run build`는 사이트맵을 생성하며 `robots.txt`의 Sitemap 주소, canonical 및 Open Graph URL은 Astro `site` 설정을 따릅니다. 404 페이지는 `dist/404.html`로 생성됩니다.

## Custom Domain

`astro.config.mjs`의 `site` 기본값을 새 도메인으로 바꾸거나 빌드 환경 변수 `SITE_URL`을 지정합니다. GitHub Pages의 Custom domain 설정과 DNS를 구성하고, 필요하면 `public/CNAME`에 도메인을 추가합니다. 각 컴포넌트의 URL을 따로 수정할 필요는 없습니다.
