       IDENTIFICATION DIVISION.
       PROGRAM-ID. PBEXTRCT.
      *****************************************************************
      * Nightly premium extract: matches the day's sorted premium
      * transactions against the policy master, validates each one,
      * prices it, and writes the good ones to the extract and the
      * bad ones to the error file.
      *****************************************************************
       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT TXN-FILE    ASSIGN TO UT-S-TXNIN.
           SELECT POLICY-FILE ASSIGN TO POLIN
                  ORGANIZATION IS INDEXED
                  ACCESS MODE IS RANDOM
                  RECORD KEY IS POL-NUMBER.
           SELECT EXTRACT-FILE ASSIGN TO EXTOUT.
           SELECT ERROR-FILE   ASSIGN TO ERROUT.
       DATA DIVISION.
       FILE SECTION.
       FD  TXN-FILE.
           COPY PBTXNREC.
       FD  POLICY-FILE.
           COPY PBPOLREC.
       FD  EXTRACT-FILE.
       01  EXTRACT-REC.
           05  EXT-POL-NUMBER      PIC X(10).
           05  EXT-PREMIUM         PIC S9(7)V99 COMP-3.
           05  EXT-DUE-DATE        PIC X(8).
       FD  ERROR-FILE.
       01  ERROR-REC               PIC X(80).
       WORKING-STORAGE SECTION.
       01  WS-CALC-PGM             PIC X(8) VALUE 'PBCALC'.
       01  WS-EOF                  PIC X VALUE 'N'.
           88  END-OF-TXNS         VALUE 'Y'.
       01  WS-VALID                PIC X.
           88  TXN-IS-VALID        VALUE 'Y'.
       01  WS-COUNTS.
           05  WS-READ             PIC 9(7) COMP-3 VALUE 0.
           05  WS-WRITTEN          PIC 9(7) COMP-3 VALUE 0.
           05  WS-REJECTED         PIC 9(7) COMP-3 VALUE 0.
       PROCEDURE DIVISION.
       0000-MAIN.
           PERFORM 1000-INIT
           PERFORM 2000-PROCESS UNTIL END-OF-TXNS
           PERFORM 3000-WRAP-UP
           STOP RUN.
      * Open the files and prime the first read.
       1000-INIT.
           OPEN INPUT  TXN-FILE POLICY-FILE
                OUTPUT EXTRACT-FILE ERROR-FILE
           PERFORM 2100-READ-TXN.
      * One transaction: find its policy, check it, price it.
       2000-PROCESS.
           MOVE TXN-POL-NUMBER TO POL-NUMBER
           READ POLICY-FILE
               INVALID KEY
                   MOVE 'NO SUCH POLICY' TO ERROR-REC
                   PERFORM 2400-REJECT
               NOT INVALID KEY
                   CALL 'PBVALID' USING TXN-REC POLICY-REC WS-VALID
                   IF TXN-IS-VALID
                       PERFORM 2200-PRICE
                       PERFORM 2300-WRITE-EXTRACT
                   ELSE
                       MOVE 'FAILED VALIDATION' TO ERROR-REC
                       PERFORM 2400-REJECT
                   END-IF
           END-READ
           PERFORM 2100-READ-TXN.
       2100-READ-TXN.
           READ TXN-FILE
               AT END SET END-OF-TXNS TO TRUE
               NOT AT END ADD 1 TO WS-READ
           END-READ.
      * The pricing module is loaded by name, so rate changes ship
      * without relinking this program.
       2200-PRICE.
           CALL WS-CALC-PGM USING POLICY-REC TXN-AMOUNT EXT-PREMIUM
           IF EXT-PREMIUM < 0
               PERFORM 9000-ABEND
           END-IF.
       2300-WRITE-EXTRACT.
           MOVE POL-NUMBER   TO EXT-POL-NUMBER
           MOVE TXN-DUE-DATE TO EXT-DUE-DATE
           WRITE EXTRACT-REC
           ADD 1 TO WS-WRITTEN.
       2400-REJECT.
           WRITE ERROR-REC
           ADD 1 TO WS-REJECTED.
       3000-WRAP-UP.
           DISPLAY 'PBEXTRCT READ ' WS-READ ' WROTE ' WS-WRITTEN
                   ' REJECTED ' WS-REJECTED
           CLOSE TXN-FILE POLICY-FILE EXTRACT-FILE ERROR-FILE.
           COPY PBERRPAR.
