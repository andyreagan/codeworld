       IDENTIFICATION DIVISION.
       PROGRAM-ID. PBCALC.
      * Premium calculation: looks up the rate factor for the
      * policy's product, rate class and issue age, and applies it.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
           EXEC SQL INCLUDE SQLCA END-EXEC.
       01  WS-FACTOR               PIC S9(3)V9(6) COMP-3.
       01  WS-PRODUCT              PIC X(4).
       01  WS-CLASS                PIC X(2).
       01  WS-AGE                  PIC S9(4) COMP.
       LINKAGE SECTION.
           COPY PBPOLREC.
       01  LS-AMOUNT               PIC S9(7)V99.
       01  LS-PREMIUM              PIC S9(7)V99 COMP-3.
       PROCEDURE DIVISION USING POLICY-REC LS-AMOUNT LS-PREMIUM.
       0000-MAIN.
           PERFORM 1000-LOOKUP-FACTOR
           PERFORM 2000-APPLY
           GOBACK.
       1000-LOOKUP-FACTOR.
           MOVE POL-PRODUCT    TO WS-PRODUCT
           MOVE POL-RATE-CLASS TO WS-CLASS
           MOVE POL-ISSUE-AGE  TO WS-AGE
           EXEC SQL
               SELECT RATE_FACTOR
                 INTO :WS-FACTOR
                 FROM PBPROD.RATE_FACTOR
                WHERE PRODUCT = :WS-PRODUCT
                  AND RATE_CLASS = :WS-CLASS
                  AND :WS-AGE BETWEEN AGE_LOW AND AGE_HIGH
           END-EXEC
           IF SQLCODE NOT = 0
               MOVE 1 TO WS-FACTOR
           END-IF.
       2000-APPLY.
           COMPUTE LS-PREMIUM ROUNDED = LS-AMOUNT * WS-FACTOR.
