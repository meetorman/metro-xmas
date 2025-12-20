 # Metro Christmas Jeopardy Game - Project Summary

## Overview
A React-based Jeopardy game application for a Christmas party where players use their smartphones as remote controls/buzzers. The game allows players to submit their own questions before gameplay begins, and an admin interface controls which questions are used and when the game starts.

## Key Features

### 1. Initial Setup Screen (TV Display)
- Displays a QR code that players can scan with their phones
- QR code links to the player registration/profile creation page

### 2. Player Profile Creation
- Players scan QR code and are taken to a registration page
- Players can enter:
  - Name or nickname
  - Profile photo (either select from iPhone photo library or take a new photo using iPhone camera)
- Profile is saved to SQLite database

### 3. Question Submission Phase
- After creating profile, players are taken to a question entry page
- Players can submit multiple questions for the Jeopardy game
- Questions are stored in SQLite database with association to the player who submitted them
- Players can continue submitting questions until the admin starts the game

### 4. Admin Interface
- Admin can view all submitted questions
- Admin can select which questions to include in the game
- Admin can organize questions into categories and point values (standard Jeopardy format)
- Admin can start the game when ready

### 5. Gameplay Phase
- Once admin starts the game, player phones switch to "buzzer mode"
- Players can buzz in to answer questions
- First player to buzz in gets to answer
- Game follows standard Jeopardy rules and flow

## Technical Requirements

### Frontend
- React application
- Responsive design for both TV display and mobile phones
- QR code generation and display
- Camera/photo library access for iPhone users
- Real-time updates (likely using WebSockets or similar for buzzer functionality)

### Backend
- Node.js/Express server (or similar)
- SQLite database for:
  - Player profiles (name, photo, unique ID)
  - Submitted questions (question text, answer, category, player who submitted)
  - Game state (selected questions, current game status, buzzer state)
- API endpoints for:
  - Player registration
  - Question submission
  - Admin question selection
  - Game control (start/stop)
  - Buzzer functionality

### Database Schema (Initial Concept)
- **players**: id, name, photo_url, created_at
- **questions**: id, player_id, question_text, answer, category, points, selected_for_game, created_at
- **game_state**: current_question_id, game_status (waiting/active/ended), buzzer_locked, last_buzz_player_id, last_buzz_time

## User Flow

1. **TV Screen**: Displays QR code and instructions
2. **Player Registration**: Scan QR → Enter name → Select/take photo → Save profile
3. **Question Entry**: Player submits questions (can submit multiple)
4. **Admin Review**: Admin reviews all questions, selects which to use, organizes into game board
5. **Game Start**: Admin clicks "Start Game"
6. **Buzzer Mode**: All player phones switch to buzzer interface
7. **Gameplay**: Admin presents question → Players buzz in → First buzzer answers → Admin marks correct/incorrect → Continue

## Additional Considerations
- Real-time synchronization between TV display and all player phones
- Buzzer timing and lockout mechanism (prevent multiple buzzes)
- Visual/audio feedback for buzzers
- Score tracking
- Mobile-optimized UI for buzzer interface
- Admin authentication/access control

